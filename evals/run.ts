// npm run eval -- [--split dev|holdout|all] [--threshold 0.8] [--checker ts|go] [--llm anthropic|oracle] [--no-cache]
// Runs the real pipeline on each synthetic day against a fresh local eval database, scores it against the
// answer keys twice ("auto" = before any human click, "after review" = queue resolved from the key, like a
// perfect attorney), sweeps the match threshold, and writes evals/reports/<timestamp>-<split>-<llm>.md and .json.
// The oracle answers from the keys, so it runs on the dev split only.
import fs from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';
import { loadEnv, loadFirm } from '@/lib/config';
import { closePools, dbUrl, getPool, migrate, resetDb } from '@/server/db';
import { draftDay } from '@/server/draft/index';
import { HttpError, resolveActivity } from '@/server/entries/service';
import { getChecker } from '@/server/guidelines/index';
import { ingestFixture } from '@/server/ingest/normalize';
import { reconcileDay } from '@/server/ingest/reconcile';
import { getLLM } from '@/server/llm/client';
import { decide, runMatching, type MatchRun } from '@/server/match/index';
import { parseThreshold } from '@/server/pipeline';
import { listDays, loadFixture, loadKey, scoreDay, type DayScore, type Snapshot } from './score';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function snapshot(pool: Pool, dayId: string): Promise<Snapshot> {
  const acts = await pool.query<{ external_id: string; merged_into: string | null; est_seconds: number }>(
    `select a.external_id, m.external_id as merged_into, a.est_seconds from activities a left join activities m on m.id = a.merged_into where a.day_id = $1`,
    [dayId],
  );
  const matches = await pool.query<{ external_id: string; status: string; category: string; matter_id: string | null }>(
    `select a.external_id, am.status, am.category, am.matter_id from activity_matches am join activities a on a.id = am.activity_id where a.day_id = $1`,
    [dayId],
  );
  const entries = await pool.query<Snapshot['entries'][number]>(
    `select e.id, e.matter_id, e.raw_seconds, e.units_tenths, e.task_code, e.activity_code, e.billable, e.status, e.origin,
            coalesce(array_agg(a.external_id) filter (where a.external_id is not null), '{}') as sources
       from time_entries e left join entry_sources es on es.entry_id = e.id left join activities a on a.id = es.activity_id
      where e.day_id = $1 group by e.id`,
    [dayId],
  );
  const flags = await pool.query<{ entry_id: string; code: string; severity: string }>(
    `select f.entry_id, f.code, f.severity from entry_flags f join time_entries e on e.id = f.entry_id where e.day_id = $1`,
    [dayId],
  );
  return {
    activities: acts.rows,
    matches: new Map(matches.rows.map((m) => [m.external_id, m])),
    entries: entries.rows.map((e) => ({ ...e, flags: flags.rows.filter((f) => f.entry_id === e.id) })),
  };
}

/** Matching metrics at another threshold, re-deciding Claude's stored answers (no new calls). */
function sweepDay(dayId: string, run: MatchRun, threshold: number): DayScore {
  const matches = new Map<string, { status: string; category: string; matter_id: string | null }>();
  for (const a of run.activities) {
    const d = decide(run.rules.get(a.id)!, run.answers.get(a.id) ?? null, run.items.get(a.id) ?? null, threshold);
    matches.set(a.external_id, { status: d.status, category: d.category, matter_id: d.matter_id });
  }
  const merged = new Map(run.activities.map((a) => [a.id, a.external_id]));
  return scoreDay(dayId, loadKey(dayId), { activities: run.activities.map((a) => ({ external_id: a.external_id, merged_into: a.merged_into ? merged.get(a.merged_into) ?? null : null, est_seconds: a.est_seconds })), matches, entries: [] });
}

const sum = (xs: DayScore[], k: keyof DayScore) => xs.reduce((s, x) => s + (x[k] as number), 0);
const ratio = (a: number, b: number) => (b ? (a / b).toFixed(2) : 'n/a');
const h = (seconds: number) => (seconds / 3600).toFixed(1);

function headline(auto: DayScore[], after: DayScore[]) {
  const traps = after.flatMap((s) => s.traps);
  const rows: [string, string, string, string][] = [
    ['Cross-client errors', String(auto.reduce((s, x) => s + x.crossClient.length, 0)), String(after.reduce((s, x) => s + x.crossClient.length, 0)), '0'],
    ['Auto precision', ratio(sum(auto, 'correctAuto'), sum(auto, 'auto')), '', '>= 0.95'],
    ['Coverage (placed without a human)', ratio(sum(auto, 'auto'), sum(auto, 'activities')), '', 'report'],
    ['Review rate', ratio(sum(auto, 'queued'), sum(auto, 'activities')), '', 'report'],
    ['Non-billable time drafted as billable', String(sum(auto, 'nonBillableBilled')), String(sum(after, 'nonBillableBilled')), '0'],
    ['Admin caught', `${sum(auto, 'adminCaught')}/${sum(auto, 'adminExpected')}`, '', 'report'],
    ['Capture ratio (observable time)', ratio(sum(auto, 'capturedSeconds'), sum(auto, 'trueObservableSeconds')), ratio(sum(after, 'capturedSeconds'), sum(after, 'trueObservableSeconds')), '0.90-1.10'],
    ['Leakage (h)', h(sum(auto, 'leakSeconds')), h(sum(after, 'leakSeconds')), 'report'],
    ['Over-capture (h)', h(sum(auto, 'overSeconds')), h(sum(after, 'overSeconds')), 'report'],
    ['Billed vs. true tenths', `${sum(auto, 'billedTenths')} / ${sum(auto, 'trueTenths')}`, `${sum(after, 'billedTenths')} / ${sum(after, 'trueTenths')}`, 'report'],
    ['Task code accuracy', '', ratio(sum(after, 'taskCorrect'), sum(after, 'paired')), 'report'],
    ['Activity code accuracy', '', ratio(sum(after, 'activityCorrect'), sum(after, 'paired')), 'report'],
    ['Blocks drafted as exactly one entry', '', `${sum(after, 'blocksOneEntry')}/${sum(after, 'blocksWithEntries')}`, 'report'],
    ['Drafts passing the vague check', '', ratio(sum(after, 'drafted') - sum(after, 'draftedVague'), sum(after, 'drafted')), '>= 0.95'],
    ['Drafts with a name not in the sources', '', String(sum(after, 'ungrounded')), 'report'],
    ['Planted traps caught', '', `${traps.filter((t) => t.passed).length}/${traps.length}`, 'report'],
    ['Block flags on clean entries', '', String(sum(after, 'falseFlags')), 'report'],
  ];
  return rows;
}

async function main() {
  loadEnv();
  const split = (arg('--split') ?? 'dev') as 'dev' | 'holdout' | 'all';
  const flag = arg('--threshold');
  const threshold = flag === undefined ? parseThreshold(process.env.MATCH_THRESHOLD) : parseThreshold(flag, '--threshold');
  if (arg('--llm')) process.env.LLM_MODE = arg('--llm');
  if (process.argv.includes('--no-cache')) process.env.LLM_CACHE = 'off';
  if (process.env.LLM_MODE === 'oracle' && (split === 'holdout' || split === 'all')) {
    throw new Error('The oracle answers from the keys, so running it on holdout would show you the answers. Use --split dev.');
  }
  const url = dbUrl('eval');
  await migrate(url);
  await resetDb(url); // keeps llm_calls, so repeated runs replay Claude's answers unless --no-cache
  const pool = getPool(url);
  const firm = loadFirm();
  const llm = await getLLM(pool);
  const checker = getChecker(arg('--checker'));
  const startedAt = new Date();
  const days = listDays(split);
  const auto: DayScore[] = [];
  const after: DayScore[] = [];
  const runs = new Map<string, MatchRun>();

  for (const dayId of days) {
    const key = loadKey(dayId);
    const { dayId: id } = await ingestFixture(pool, loadFixture(dayId), firm.attorney.id);
    await reconcileDay(pool, id, firm);
    runs.set(dayId, await runMatching(pool, id, firm, llm, threshold));
    await draftDay(pool, id, firm, llm, checker);
    auto.push(scoreDay(dayId, key, await snapshot(pool, id)));

    // A perfect attorney clears the queue from the key, then the new activities are drafted.
    const queued = await pool.query<{ id: string; external_id: string }>(
      `select a.id, a.external_id from activities a join activity_matches am on am.activity_id = a.id where a.day_id = $1 and am.status = 'needs_review'`,
      [id],
    );
    const blocks = new Map(key.blocks.map((b) => [b.id, b]));
    for (const q of queued.rows) {
      const blockId = key.activities[q.external_id]?.block_id;
      const b = blockId ? blocks.get(blockId) : undefined;
      const choice = !b ? { category: 'ignore' as const } : b.category === 'billable' ? { matter_id: b.matter_id! } : { category: b.category };
      try {
        await resolveActivity(pool, q.id, choice, 'eval:answer-key');
      } catch (err) {
        if (!(err instanceof HttpError && err.status === 409)) throw err; // already placed with its thread
      }
    }
    if (queued.rowCount) await draftDay(pool, id, firm, llm, checker);
    after.push(scoreDay(dayId, key, await snapshot(pool, id)));
    process.stdout.write(`${dayId} `);
  }
  process.stdout.write('\n');

  const sweep = [0.6, 0.7, 0.8, 0.9].map((t) => {
    const s = days.map((d) => sweepDay(d, runs.get(d)!, t));
    return { threshold: t, precision: ratio(sum(s, 'correctAuto'), sum(s, 'auto')), coverage: ratio(sum(s, 'auto'), sum(s, 'activities')), crossClient: s.reduce((x, d) => x + d.crossClient.length, 0) };
  });
  const calls = await pool.query<{ purpose: string; calls: number; input_tokens: number; output_tokens: number; p50: number; p95: number }>(
    `select purpose, count(*)::int as calls, coalesce(sum(input_tokens), 0)::int as input_tokens, coalesce(sum(output_tokens), 0)::int as output_tokens,
            coalesce(percentile_cont(0.5) within group (order by latency_ms), 0)::int as p50, coalesce(percentile_cont(0.95) within group (order by latency_ms), 0)::int as p95
       from llm_calls where created_at >= $1 group by purpose order by purpose`,
    [startedAt],
  );

  const rows = headline(auto, after);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const llmLabel = llm.name === 'oracle' ? 'oracle (answer-key stand-in: tests the machinery, NOT a Claude result)' : `Claude (${process.env.MODEL_MATCH ?? 'claude-haiku-4-5-20251001'} for matching, ${process.env.MODEL_DRAFT ?? 'claude-sonnet-5-5'} for drafting)`;
  const md = [
    `# TimeDraft eval: ${split} split, ${days.length} days`,
    '',
    `Run ${new Date().toISOString()}. LLM: ${llmLabel}. Checker: ${checker.name}. Match threshold: ${threshold}. Cache: ${process.env.LLM_CACHE ?? 'on'}.`,
    '',
    '## Headline',
    '',
    '| Metric | Auto | After review | Target |',
    '| --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.join(' | ')} |`),
    '',
    '## Threshold sweep (matching only, same Claude answers re-decided)',
    '',
    '| Threshold | Auto precision | Coverage | Cross-client errors |',
    '| --- | --- | --- | --- |',
    ...sweep.map((s) => `| ${s.threshold} | ${s.precision} | ${s.coverage} | ${s.crossClient} |`),
    '',
    '## Per day (after review)',
    '',
    '| Day | Activities | Placed automatically | Queued | Captured h | True h (observable) | Traps caught |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...after.map((s, i) => `| ${s.day} | ${s.activities} | ${auto[i].auto} | ${auto[i].queued} | ${h(s.capturedSeconds)} | ${h(s.trueObservableSeconds)} | ${s.traps.filter((t) => t.passed).length}/${s.traps.length} |`),
    '',
    '## Cross-client errors',
    '',
    ...(auto.some((s) => s.crossClient.length) ? auto.flatMap((s) => s.crossClient.map((c) => `- ${s.day} ${c.activity}: placed on ${c.predicted}, belongs to ${c.expected}`)) : ['None.']),
    '',
    '## Missed traps',
    '',
    ...(after.some((s) => s.traps.some((t) => !t.passed)) ? after.flatMap((s) => s.traps.filter((t) => !t.passed).map((t) => `- ${s.day} ${t.kind}: ${t.detail}`)) : ['None.']),
    '',
    '## Model calls',
    '',
    '| Purpose | Calls | Input tokens | Output tokens | p50 ms | p95 ms |',
    '| --- | --- | --- | --- | --- | --- |',
    ...(calls.rows.length ? calls.rows.map((c) => `| ${c.purpose} | ${c.calls} | ${c.input_tokens} | ${c.output_tokens} | ${c.p50} | ${c.p95} |`) : ['| none (oracle or fully cached) | 0 | 0 | 0 | 0 | 0 |']),
    '',
  ].join('\n');

  const outDir = path.join('evals', 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const name = `${stamp}-${split}-${llm.name}`; // the LLM in the name keeps an oracle report from passing for a Claude one
  fs.writeFileSync(path.join(outDir, `${name}.md`), md);
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify({ split, threshold, llm: llm.name, checker: checker.name, headline: rows, sweep, auto, after, calls: calls.rows }, null, 2));
  console.log(md.split('## Per day')[0]);
  console.log(`Report: evals/reports/${name}.md`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePools());
