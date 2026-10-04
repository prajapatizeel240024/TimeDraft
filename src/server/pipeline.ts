// Runs a day through the stages: reconcile -> match -> draft, emitting progress events for the screen.
// Each stage saves its results before the next starts, so a failed run can pick up where it stopped.
import type { Pool } from 'pg';
import { loadEnv, loadFirm, matterById } from '@/lib/config';
import type { GuidelineChecker, LLM, RewriteOutput } from '@/lib/types';
import { draftDay } from '@/server/draft/index';
import { getChecker } from '@/server/guidelines/index';
import { activityTitle, getEntryViews, getQueue, HttpError, resolveActivity, type EntryView, type QueueItem } from '@/server/entries/service';
import { reconcileDay } from '@/server/ingest/reconcile';
import { getLLM } from '@/server/llm/client';
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

export async function defaultDeps(pool: Pool): Promise<Deps> {
  loadEnv();
  return { llm: await getLLM(pool), checker: getChecker(), threshold: Number(process.env.MATCH_THRESHOLD ?? '0.8') };
}

export async function runDay(pool: Pool, dayId: string, emit: (e: PipelineEvent) => void | Promise<void>, deps: Deps): Promise<void> {
  const firm = loadFirm();
  const status = async () => (await pool.query<{ status: string }>('select status from days where id = $1', [dayId])).rows[0]?.status;
  try {
    if ((await status()) === undefined) throw new HttpError(404, 'That day has not been loaded.');
    if ((await status()) === 'ingested') {
      await emit({ type: 'stage', stage: 'reconcile', message: 'Merging calendar events with their call logs' });
      await reconcileDay(pool, dayId, firm);
    }
    const matched = await pool.query('select 1 from activity_matches am join activities a on a.id = am.activity_id where a.day_id = $1 limit 1', [dayId]);
    if (!matched.rowCount) {
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

/** The attorney places a queued activity; if it's billable work, its new entries are drafted right away. */
export async function resolveAndDraft(pool: Pool, activityId: string, choice: { matter_id: string } | { category: 'admin' | 'personal' | 'ignore' }, actor: string, deps: Deps): Promise<EntryView[]> {
  const res = await resolveActivity(pool, activityId, choice, actor);
  if (!res.matterId) return [];
  const summary = await draftDay(pool, res.dayId, loadFirm(), deps.llm, deps.checker);
  return getEntryViews(pool, { ids: summary.entryIds });
}

/** A rewrite suggestion only; saving it is a normal edit with via: "rewrite". */
export async function suggestRewrite(pool: Pool, entryId: string, hint: string, llm: LLM): Promise<RewriteOutput> {
  const e = await pool.query<{ matter_id: string; narrative: string; task_code: string; activity_code: string; status: string }>('select matter_id, narrative, task_code, activity_code, status from time_entries where id = $1', [entryId]);
  if (!e.rowCount) throw new HttpError(404, 'That entry no longer exists.');
  if (e.rows[0].status !== 'draft') throw new HttpError(409, 'Only drafts can be rewritten. Reopen the entry first.');
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
  return { status: out.status, narrative: out.narrative, question: out.question, facts_used: out.facts_used };
}

/** Maps errors to JSON responses for the API routes: HttpError keeps its status, bad input is a 400. */
export function jsonError(err: unknown): Response {
  if (err instanceof HttpError) return Response.json({ error: err.message }, { status: err.status });
  if (err && typeof err === 'object' && 'issues' in err) return Response.json({ error: 'The request body is not valid.', issues: (err as { issues: unknown }).issues }, { status: 400 });
  const message = err instanceof Error ? err.message : String(err);
  console.error(err);
  return Response.json({ error: message }, { status: 500 });
}

export function attorneyActor(): string {
  return `attorney:${loadFirm().attorney.id}`;
}
