// Postgres access: pooled connections, transactions, migrations and seeding. Local hosts only.
import fs from 'node:fs';
import path from 'node:path';
import pg, { Client, Pool, type PoolClient } from 'pg';
import { loadEnv, loadFirm, matterCard } from '@/lib/config';

// DATE columns come back as 'YYYY-MM-DD' strings, never as local-midnight Date objects.
pg.types.setTypeParser(1082, (v: string) => v);

export type Queryable = Pool | PoolClient;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function assertLocal(url: string): void {
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`Refusing to use database host "${host}". TimeDraft only talks to local Postgres.`);
  }
}

export function dbUrl(which: 'dev' | 'eval' = 'dev'): string {
  loadEnv();
  const url = which === 'eval' ? process.env.EVAL_DATABASE_URL : process.env.DATABASE_URL;
  const name = which === 'eval' ? 'EVAL_DATABASE_URL' : 'DATABASE_URL';
  if (!url) throw new Error(`${name} is not set. Copy .env.example to .env.local.`);
  assertLocal(url);
  return url;
}

const g = globalThis as unknown as { __timedraftPools?: Map<string, Pool> };

export function getPool(url: string = dbUrl('dev')): Pool {
  assertLocal(url);
  g.__timedraftPools ??= new Map();
  let pool = g.__timedraftPools.get(url);
  if (!pool) {
    pool = new Pool({ connectionString: url, max: 6 });
    g.__timedraftPools.set(url, pool);
  }
  return pool;
}

export async function closePools(): Promise<void> {
  const pools = [...(g.__timedraftPools?.values() ?? [])];
  g.__timedraftPools?.clear();
  await Promise.all(pools.map((p) => p.end()));
}

export async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Creates the database named in the URL if it doesn't exist yet (needs CREATEDB). */
export async function ensureDatabase(url: string): Promise<void> {
  assertLocal(url);
  const target = new URL(url);
  const dbName = decodeURIComponent(target.pathname.slice(1));
  if (!/^[a-z0-9_]+$/.test(dbName)) throw new Error(`Unexpected database name "${dbName}"`);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const found = await client.query('select 1 from pg_database where datname = $1', [dbName]);
    if (!found.rowCount) await client.query(`create database ${dbName}`);
  } finally {
    await client.end();
  }
}

export async function migrate(url: string): Promise<string[]> {
  await ensureDatabase(url);
  const pool = getPool(url);
  await pool.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  const dir = path.join(process.cwd(), 'db', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    const done = await pool.query('select 1 from schema_migrations where name = $1', [file]);
    if (done.rowCount) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await withTx(pool, async (c) => {
      await c.query(sql);
      await c.query('insert into schema_migrations (name) values ($1)', [file]);
    });
    applied.push(file);
  }
  return applied;
}

export async function seed(url: string): Promise<void> {
  const firm = loadFirm();
  const pool = getPool(url);
  await pool.query(fs.readFileSync(path.join(process.cwd(), 'db', 'seed', 'utbms.sql'), 'utf8'));
  const a = firm.attorney;
  await pool.query(
    `insert into attorneys (id, name, email, classification, rate_cents) values ($1,$2,$3,$4,$5)
     on conflict (id) do update set name = excluded.name, email = excluded.email,
       classification = excluded.classification, rate_cents = excluded.rate_cents`,
    [a.id, a.name, a.email, a.classification, a.rate_cents],
  );
  for (const m of firm.matters) {
    const card = { text: matterCard(firm, m), parties: m.parties, client: m.client, keywords: m.keywords, doc_folders: m.doc_folders, short_name: m.short_name };
    await pool.query(
      `insert into matters (id, name, client_name, ledes_client_id, client_matter_id, stage, profile, card)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (id) do update set name = excluded.name, client_name = excluded.client_name,
         ledes_client_id = excluded.ledes_client_id, client_matter_id = excluded.client_matter_id,
         stage = excluded.stage, profile = excluded.profile, card = excluded.card`,
      [m.id, m.name, m.client.name, m.client.ledes_client_id, m.client.client_matter_id, m.stage, firm.profiles[m.profile], card],
    );
  }
}

/** Empties the app tables. Keeps utbms_codes and llm_calls (the response cache) unless all=true. */
export async function resetDb(url: string, opts: { all?: boolean } = {}): Promise<void> {
  const pool = getPool(url);
  const tables = ['exports', 'audit_events', 'entry_flags', 'entry_sources', 'time_entries', 'activity_matches', 'activities', 'days', 'matters', 'attorneys'];
  if (opts.all) tables.push('llm_calls');
  // TRUNCATE skips row triggers, which is acceptable only because assertLocal() guards every URL.
  await pool.query(`truncate ${tables.join(', ')} restart identity cascade`);
  await seed(url);
}
