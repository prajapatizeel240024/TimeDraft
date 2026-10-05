// Runs a day through the stages: reconcile -> match -> draft, emitting progress events for the screen.
// Each stage saves its results before the next starts, so a failed run can pick up where it stopped.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { YAMLError } from 'yaml';
import { loadEnv, loadFirm, matterById, type FirmConfig } from '@/lib/config';
import type { GuidelineChecker, LLM, RewriteSuggestion } from '@/lib/types';
import { draftDay } from '@/server/draft/index';
import { getChecker } from '@/server/guidelines/index';
import { activityTitle, getEntryViews, getQueue, HttpError, resolveActivity, type EntryView, type QueueItem } from '@/server/entries/service';
import { reconcileDay } from '@/server/ingest/reconcile';
import { getLLM, LLMUnavailableError, ModelOutputError, RefusalError } from '@/server/llm/client';
import { localTime } from '@/server/match/llm';
import { runMatching } from '@/server/match/index';

export type PipelineEvent =
  | { type: 'stage'; stage: 'reconcile' | 'match' | 'draft'; message: string }
  | { type: 'match_summary'; auto: number; queued: number; ignored: number; asked_claude: number }
  | { type: 'entry'; entry: EntryView }
  | { type: 'review_item'; item: QueueItem }
  | { type: 'done'; status: string }
  | { type: 'error'; message: string };

export interface Deps {
  llm: LLM;
  checker: GuidelineChecker;
  threshold: number;
}

/** MATCH_THRESHOLD, or --threshold for the eval: unset means 0.8, and anything but a number above 0 and at most 1 throws. */
export function parseThreshold(raw: string | undefined, name = 'MATCH_THRESHOLD'): number {
  if (raw === undefined) return 0.8;
  const value = Number(raw);
  if (!raw.trim() || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${name} must be a number above 0 and at most 1, such as 0.80. Got "${raw}".`);
  }
  return value;
}

export async function defaultDeps(pool: Pool): Promise<Deps> {
  loadEnv();
  return { llm: await getLLM(pool), checker: getChecker(), threshold: parseThreshold(process.env.MATCH_THRESHOLD) };
}

/** Says what is wrong with config/firm.yaml, naming the file. */
function firmConfigMessage(err: unknown): string {
  if (err instanceof YAMLError) return `config/firm.yaml is not valid YAML: ${err.message.split('\n')[0].replace(/:\s*$/, '')}`;
  if (err && typeof err === 'object' && 'issues' in err) {
    const issues = (err as { issues: { path: PropertyKey[]; message: string }[] }).issues;
    return `config/firm.yaml is not valid: ${issues.slice(0, 3).map((i) => `${i.path.map(String).join('.') || 'top level'}: ${i.message}`).join('; ')}`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('config/firm.yaml') ? message : `config/firm.yaml could not be loaded: ${message}`;
}

/** loadFirm(), except that a broken config/firm.yaml throws an error that names it. */
function loadFirmOrExplain(): FirmConfig {
  try {
    return loadFirm();
  } catch (err) {
    throw new Error(firmConfigMessage(err), { cause: err });
  }
}

/** Null when config/firm.yaml loads, otherwise what is wrong with it. */
function firmConfigProblem(): string | null {
  try {
    loadFirm();
    return null;
  } catch (err) {
    return firmConfigMessage(err);
  }
}

export async function runDay(pool: Pool, dayId: string, emit: (e: PipelineEvent) => void | Promise<void>, deps: Deps): Promise<void> {
  const status = async () => (await pool.query<{ status: string }>('select status from days where id = $1', [dayId])).rows[0]?.status;
  try {
    const firm = loadFirmOrExplain();
    if ((await status()) === undefined) throw new HttpError(404, 'That day has not been loaded.');
    await refuseOracleOnHoldout(pool, dayId, deps.llm);
    const matched = await pool.query('select 1 from activity_matches am join activities a on a.id = am.activity_id where a.day_id = $1 limit 1', [dayId]);
    // Until the day has matches, reconcile and match both run. A failed run leaves the status at 'failed' whatever
    // stage it stopped in, so reconcile can't be skipped by status; it skips what it already merged instead.
    if (!matched.rowCount) {
      await emit({ type: 'stage', stage: 'reconcile', message: 'Merging calendar events with their call logs' });
      await reconcileDay(pool, dayId, firm);
      await emit({ type: 'stage', stage: 'match', message: 'Matching activities to matters' });
      const run = await runMatching(pool, dayId, firm, deps.llm, deps.threshold);
      const ds = [...run.decisions.values()];
      await emit({ type: 'match_summary', auto: ds.filter((d) => d.status === 'auto').length, queued: ds.filter((d) => d.status === 'needs_review').length, ignored: ds.filter((d) => d.status === 'ignored').length, asked_claude: run.items.size });
      for (const item of await getQueue(pool, dayId)) await emit({ type: 'review_item', item });
    }
    await emit({ type: 'stage', stage: 'draft', message: 'Drafting entries' });
    await draftDay(pool, dayId, firm, deps.llm, deps.checker, async (_matterId, ids) => {
      for (const entry of await getEntryViews(pool, { ids })) await emit({ type: 'entry', entry });
    });
    await emit({ type: 'done', status: (await status()) ?? 'unknown' });
  } catch (err) {
    await pool.query(`update days set status = 'failed' where id = $1`, [dayId]).catch(() => undefined);
    await emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

/** The oracle answers from the answer keys, so it never runs on a holdout day: that would show the answers. */
async function refuseOracleOnHoldout(pool: Pool, dayId: string, llm: LLM): Promise<void> {
  if (llm.name !== 'oracle') return;
  const day = await pool.query<{ fixture_id: string }>('select fixture_id from days where id = $1', [dayId]);
  const fixture = day.rows[0]?.fixture_id;
  if (!fixture) return;
  const { listDays } = await import('../../evals/score');
  if (listDays('holdout').includes(fixture)) {
    throw new HttpError(422, `The oracle answers from the keys, so it never runs on a holdout day like ${fixture}. Use a dev day (01 to 08).`);
  }
}

/** The attorney places a queued activity; if it's billable work, its new entries are drafted right away. */
export async function resolveAndDraft(pool: Pool, activityId: string, choice: { matter_id: string } | { category: 'admin' | 'personal' | 'ignore' }, actor: string, deps: Deps): Promise<EntryView[]> {
  if ('matter_id' in choice) {
    // Picking a matter drafts at once, so the oracle check comes before anything is saved.
    const activity = await pool.query<{ day_id: string }>('select day_id from activities where id = $1', [activityId]);
    if (activity.rowCount) await refuseOracleOnHoldout(pool, activity.rows[0].day_id, deps.llm);
  }
  const res = await resolveActivity(pool, activityId, choice, actor);
  if (!res.matterId) return [];
  let summary: Awaited<ReturnType<typeof draftDay>>;
  try {
    summary = await draftDay(pool, res.dayId, loadFirm(), deps.llm, deps.checker);
  } catch (err) {
    // The placement is already saved. Marking the day failed lets "Try again" draft it.
    await pool.query(`update days set status = 'failed' where id = $1`, [res.dayId]).catch(() => undefined);
    throw err;
  }
  return getEntryViews(pool, { ids: summary.entryIds });
}

/** A rewrite suggestion only. Saving it is a PATCH that carries the token, and the route checks it with verifyRewriteToken. */
export async function suggestRewrite(pool: Pool, entryId: string, hint: string, llm: LLM): Promise<RewriteSuggestion> {
  const e = await pool.query<{ day_id: string; matter_id: string; narrative: string; task_code: string; activity_code: string; status: string; version: number }>('select day_id, matter_id, narrative, task_code, activity_code, status, version from time_entries where id = $1', [entryId]);
  if (!e.rowCount) throw new HttpError(404, 'That entry no longer exists.');
  if (e.rows[0].status !== 'draft') throw new HttpError(409, 'Only drafts can be rewritten. Reopen the entry first.');
  await refuseOracleOnHoldout(pool, e.rows[0].day_id, llm);
  matterById(loadFirm(), e.rows[0].matter_id);
  const flags = await pool.query<{ message: string }>(`select message from entry_flags where entry_id = $1`, [entryId]);
  const sources = await pool.query<{ external_id: string; source: 'email' | 'calendar' | 'doc' | 'call'; started_at: Date; body: string; meta: Record<string, unknown> }>(
    `select a.external_id, a.source, a.started_at, a.body, a.meta from entry_sources es join activities a on a.id = es.activity_id where es.entry_id = $1 order by a.started_at`,
    [entryId],
  );
  const out = await llm.rewrite({
    matter_id: e.rows[0].matter_id,
    narrative: e.rows[0].narrative,
    task_code: e.rows[0].task_code,
    activity_code: e.rows[0].activity_code,
    flags: flags.rows.map((f) => f.message),
    sources: sources.rows.map((s, i) => ({ ref: `s${i + 1}`, external_id: s.external_id, source: s.source, when: localTime(s.started_at.toISOString()), text: `${activityTitle(s.source, s.body, s.meta)}\n${s.body}`.slice(0, 700) })),
    hint,
  });
  const token = out.status === 'rewritten' ? rewriteMac(entryId, e.rows[0].version, out.narrative).toString('hex') : '';
  return { status: out.status, narrative: out.narrative, question: out.question, facts_used: out.facts_used, token };
}

// The random fallback key lives on globalThis, like the pools in db.ts, so every route bundle in the process shares it.
const g = globalThis as unknown as { __timedraftRewriteKey?: Buffer };

/** REWRITE_SIGNING_KEY, or a random 32-byte key made once per process. */
function rewriteKey(): Buffer {
  loadEnv();
  if (process.env.REWRITE_SIGNING_KEY) return Buffer.from(process.env.REWRITE_SIGNING_KEY);
  g.__timedraftRewriteKey ??= randomBytes(32);
  return g.__timedraftRewriteKey;
}

function rewriteMac(entryId: string, version: number, narrative: string): Buffer {
  return createHmac('sha256', rewriteKey()).update(`${entryId}\n${version}\n${narrative.trim()}`).digest();
}

/** True only for the token suggestRewrite issued for this entry, at this version, for this exact narrative. */
export function verifyRewriteToken(entryId: string, version: number, narrative: string, token: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(token)) return false;
  return timingSafeEqual(rewriteMac(entryId, version, narrative), Buffer.from(token, 'hex'));
}

const isPgError = (err: unknown, code: string) => typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;

/** Maps errors to JSON responses for the API routes. */
export function jsonError(err: unknown): Response {
  if (err instanceof HttpError) return Response.json({ error: err.message }, { status: err.status });
  if (err instanceof ModelOutputError || err instanceof RefusalError) return Response.json({ error: err.message }, { status: 502 });
  if (err instanceof LLMUnavailableError) return Response.json({ error: err.message }, { status: 503 });
  if (isPgError(err, '22P02')) return Response.json({ error: "That id isn't valid." }, { status: 400 });
  const zod = typeof err === 'object' && err !== null && 'issues' in err;
  // A config/firm.yaml that isn't valid YAML or fails validation is the server's fault, not bad input: 500, naming the file.
  const firm = zod || err instanceof YAMLError ? firmConfigProblem() : null;
  if (firm) {
    console.error(err);
    return Response.json({ error: firm }, { status: 500 });
  }
  if (zod) return Response.json({ error: 'The request body is not valid.', issues: (err as { issues: unknown }).issues }, { status: 400 });
  const message = err instanceof Error ? err.message : String(err);
  console.error(err);
  return Response.json({ error: message }, { status: 500 });
}

export function attorneyActor(): string {
  return `attorney:${loadFirm().attorney.id}`;
}
