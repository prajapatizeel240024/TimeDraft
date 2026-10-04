// The only code that writes time_entries, entry_flags and audit_events. Every change locks the entry,
// checks the version the client saw, writes the change and exactly one audit row in one transaction,
// then recomputes the day's flags with the configured checker.
import type { Pool, PoolClient } from 'pg';
import { loadFirm, matterById } from '@/lib/config';
import type { Category, CheckEntry, EntryStatus, Flag, GuidelineChecker, Profile, Words } from '@/lib/types';
import { isActivityCode, isTaskCode, normalizeCode } from '@/lib/utbms';
import { withTx, type Queryable } from '@/server/db';
import { entrySeconds, intervalsOf, type TimedSource } from '@/server/time/intervals';
import { toTenths } from '@/server/time/rounding';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface EntryRow {
  id: string;
  day_id: string;
  matter_id: string;
  work_date: string;
  units_tenths: number;
  raw_seconds: number;
  task_code: string;
  activity_code: string;
  narrative: string;
  thin_context: boolean;
  billable: boolean;
  status: EntryStatus;
  origin: 'drafter' | 'attorney';
  why: string;
  prompt_version: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const EDITABLE = ['units_tenths', 'task_code', 'activity_code', 'narrative', 'billable', 'thin_context'] as const;
type Editable = (typeof EDITABLE)[number];

function snapshot(e: Pick<EntryRow, Editable | 'status'>, keys: readonly string[] = [...EDITABLE, 'status']): Record<string, unknown> {
  return Object.fromEntries(keys.map((k) => [k, (e as Record<string, unknown>)[k]]));
}

/** Writes one audit row. Ingest, matching and LEDES export call this inside their own transactions, so this file stays the only writer of audit_events. */
export async function audit(c: Queryable, a: { subject_type: 'entry' | 'activity' | 'day' | 'export'; subject_id: string; version?: number | null; actor: string; action: string; before?: unknown; after?: unknown; reason?: string | null }): Promise<void> {
  await c.query(
    `insert into audit_events (subject_type, subject_id, version, actor, action, before, after, reason) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [a.subject_type, a.subject_id, a.version ?? null, a.actor, a.action, a.before === undefined ? null : JSON.stringify(a.before), a.after === undefined ? null : JSON.stringify(a.after), a.reason ?? null],
  );
}

export interface NewEntry {
  dayId: string;
  matterId: string;
  workDate: string;
  sources: TimedSource[];
  taskCode: string;
  activityCode: string;
  narrative: string;
  thin: boolean;
  why: string;
  promptVersion: string | null;
  actor: string;
  ungrounded?: string[];
}

/** Creates a draft entry: time from the sources (never from Claude), rounded up to tenths once. */
export async function createDraftEntry(c: PoolClient, n: NewEntry): Promise<string> {
  const { total, perActivity } = entrySeconds(n.sources);
  if (total <= 0) throw new HttpError(422, 'An entry needs some recorded time.');
  const units = Math.min(240, toTenths(total));
  const res = await c.query<EntryRow>(
    `insert into time_entries (day_id, matter_id, work_date, units_tenths, raw_seconds, task_code, activity_code, narrative, thin_context, origin, why, prompt_version)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'drafter',$10,$11) returning *`,
    [n.dayId, n.matterId, n.workDate, units, total, n.taskCode, n.activityCode, n.narrative, n.thin, n.why, n.promptVersion],
  );
  const e = res.rows[0];
  for (const s of n.sources) await c.query('insert into entry_sources (entry_id, activity_id, seconds) values ($1,$2,$3)', [e.id, s.id, perActivity.get(s.id) ?? 0]);
  for (const term of n.ungrounded ?? []) {
    await c.query(
      `insert into entry_flags (entry_id, code, severity, message, evidence, checker) values ($1,'UNGROUNDED_TERM','warn',$2,$3,'validator@1')`,
      [e.id, `"${term}" doesn't appear in any source or in the matter card. Check it before approving.`, JSON.stringify([term])],
    );
  }
  await audit(c, { subject_type: 'entry', subject_id: e.id, version: 1, actor: n.actor, action: 'created', after: { ...snapshot(e), raw_seconds: total, sources: n.sources.map((s) => s.id) } });
  return e.id;
}

interface FlagContext {
  checker: GuidelineChecker;
  words: Words;
}

export function checkContext(checker: GuidelineChecker): FlagContext {
  return { checker, words: loadFirm().words };
}

/** Builds the checker input for a day: every non-rejected entry, its source categories and intervals. */
export async function checkInputForDay(db: Queryable, dayId: string, words: Words): Promise<{ input: { profiles: Record<string, Profile>; words: Words; daily_max_tenths: number; entries: CheckEntry[] } }> {
  const entries = await db.query<EntryRow>(`select * from time_entries where day_id = $1 and status <> 'rejected' order by created_at, id`, [dayId]);
  const srcs = await db.query<{ entry_id: string; activity_id: string; source: TimedSource['source']; started_at: Date; est_seconds: number; category: Category | null }>(
    `select es.entry_id, a.id as activity_id, a.source, a.started_at, a.est_seconds, am.category
       from entry_sources es join activities a on a.id = es.activity_id
       left join activity_matches am on am.activity_id = a.id
      where es.entry_id = any($1::uuid[])`,
    [entries.rows.map((e) => e.id)],
  );
  const matters = await db.query<{ id: string; profile: Profile }>('select id, profile from matters');
  const profiles = Object.fromEntries(matters.rows.map((m) => [m.id, m.profile]));
  const bySource = new Map<string, typeof srcs.rows>();
  for (const s of srcs.rows) bySource.set(s.entry_id, [...(bySource.get(s.entry_id) ?? []), s]);
  const checkEntries: CheckEntry[] = entries.rows.map((e) => {
    const s = bySource.get(e.id) ?? [];
    return {
      id: e.id,
      profile: e.matter_id,
      units_tenths: e.units_tenths,
      task_code: e.task_code,
      activity_code: e.activity_code,
      narrative: e.narrative,
      thin_context: e.thin_context,
      billable: e.billable,
      source_categories: [...new Set(s.map((x) => x.category ?? 'unknown'))],
      intervals: intervalsOf(s.map((x) => ({ id: x.activity_id, source: x.source, started_at: x.started_at.toISOString(), est_seconds: x.est_seconds }))),
    };
  });
  const daily = Math.min(...Object.values(profiles).map((p) => p.daily_max_tenths));
  return { input: { profiles, words, daily_max_tenths: daily, entries: checkEntries } };
}

/** Replaces checker flags for every entry of the day. Keeps validator flags and override reasons. */
export async function recomputeDayFlags(c: PoolClient, dayId: string, ctx: FlagContext): Promise<Flag[]> {
  const { input } = await checkInputForDay(c, dayId, ctx.words);
  const flags = await ctx.checker.check(input);
  const ids = input.entries.map((e) => e.id);
  const kept = await c.query<{ entry_id: string; code: string; override_reason: string }>(
    `select entry_id, code, override_reason from entry_flags where entry_id = any($1::uuid[]) and override_reason is not null`,
    [ids],
  );
  const overrides = new Map(kept.rows.map((r) => [`${r.entry_id}:${r.code}`, r.override_reason]));
  await c.query(`delete from entry_flags where entry_id = any($1::uuid[]) and code <> 'UNGROUNDED_TERM'`, [ids]);
  for (const f of flags) {
    if (!f.entry_id) continue; // day-level flags are computed when the day is read
    await c.query(
      `insert into entry_flags (entry_id, code, severity, message, evidence, checker, override_reason) values ($1,$2,$3,$4,$5,$6,$7)`,
      [f.entry_id, f.code, f.severity, f.message, JSON.stringify(f.evidence), ctx.checker.name, overrides.get(`${f.entry_id}:${f.code}`) ?? null],
    );
  }
  return flags;
}

async function lockEntry(c: PoolClient, id: string, version: number): Promise<EntryRow> {
  const res = await c.query<EntryRow>('select * from time_entries where id = $1 for update', [id]);
  const e = res.rows[0];
  if (!e) throw new HttpError(404, 'That entry no longer exists.');
  if (e.version !== version) throw new HttpError(409, 'This entry changed since you loaded it. Reload to see the latest version.');
  return e;
}

export interface EntryPatch {
  version: number;
  units_tenths?: number;
  task_code?: string;
  activity_code?: string;
  narrative?: string;
  billable?: boolean;
  via?: 'edit' | 'rewrite';
}

export async function editEntry(pool: Pool, id: string, patch: EntryPatch, actor: string, ctx: FlagContext): Promise<void> {
  await withTx(pool, async (c) => {
    const e = await lockEntry(c, id, patch.version);
    if (e.status !== 'draft') throw new HttpError(409, 'Only drafts can be edited. Reopen the entry first.');
    const next: Record<string, unknown> = {};
    if (patch.units_tenths !== undefined && patch.units_tenths !== e.units_tenths) next.units_tenths = patch.units_tenths;
    if (patch.task_code !== undefined) {
      const code = normalizeCode(patch.task_code);
      if (!isTaskCode(code)) throw new HttpError(422, `${patch.task_code} isn't a UTBMS litigation task code.`);
      if (code !== e.task_code) next.task_code = code;
    }
    if (patch.activity_code !== undefined) {
      const code = normalizeCode(patch.activity_code);
      if (!isActivityCode(code)) throw new HttpError(422, `${patch.activity_code} isn't a UTBMS activity code.`);
      if (code !== e.activity_code) next.activity_code = code;
    }
    if (patch.narrative !== undefined && patch.narrative.trim() !== e.narrative) {
      next.narrative = patch.narrative.trim();
      next.thin_context = false; // the attorney has now supplied the purpose
    }
    if (patch.billable !== undefined && patch.billable !== e.billable) next.billable = patch.billable;
    const keys = Object.keys(next);
    if (!keys.length) return;
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    await c.query(`update time_entries set ${sets}, version = version + 1, updated_at = now() where id = $1`, [id, ...keys.map((k) => next[k])]);
    if (next.narrative !== undefined) await c.query(`delete from entry_flags where entry_id = $1 and code = 'UNGROUNDED_TERM'`, [id]);
    const rewrite = patch.via === 'rewrite';
    await audit(c, { subject_type: 'entry', subject_id: id, version: e.version + 1, actor: rewrite ? `${actor} via claude:rewrite.v1` : actor, action: rewrite ? 'rewritten' : 'edited', before: snapshot(e, keys), after: next });
    await recomputeDayFlags(c, e.day_id, ctx);
  });
}

export async function approveEntry(pool: Pool, id: string, body: { version: number; override_reason?: string }, actor: string): Promise<void> {
  await withTx(pool, async (c) => {
    const e = await lockEntry(c, id, body.version);
    if (e.status !== 'draft') throw new HttpError(409, `This entry is already ${e.status}.`);
    const blocking = await c.query<{ code: string; message: string }>(`select code, message from entry_flags where entry_id = $1 and severity = 'block'`, [id]);
    const reason = body.override_reason?.trim();
    if (blocking.rowCount && !reason) {
      throw new HttpError(422, `Fix ${blocking.rows.map((f) => f.code.replace(/_/g, ' ').toLowerCase()).join(' and ')} first, or give a reason to approve anyway.`);
    }
    if (blocking.rowCount) await c.query(`update entry_flags set override_reason = $2 where entry_id = $1 and severity = 'block'`, [id, reason]);
    await c.query(`update time_entries set status = 'approved', version = version + 1, updated_at = now() where id = $1`, [id]);
    await audit(c, { subject_type: 'entry', subject_id: id, version: e.version + 1, actor, action: 'approved', before: { status: e.status }, after: { status: 'approved', overridden: blocking.rows.map((f) => f.code) }, reason: reason ?? null });
  });
}

export async function rejectEntry(pool: Pool, id: string, body: { version: number; reason: string }, actor: string, ctx: FlagContext): Promise<void> {
  await withTx(pool, async (c) => {
    const e = await lockEntry(c, id, body.version);
    if (e.status === 'rejected') throw new HttpError(409, 'This entry is already rejected.');
    await c.query(`update time_entries set status = 'rejected', version = version + 1, updated_at = now() where id = $1`, [id]);
    await audit(c, { subject_type: 'entry', subject_id: id, version: e.version + 1, actor, action: 'rejected', before: { status: e.status }, after: { status: 'rejected' }, reason: body.reason });
    await recomputeDayFlags(c, e.day_id, ctx);
  });
}

export async function reopenEntry(pool: Pool, id: string, body: { version: number }, actor: string, ctx: FlagContext): Promise<void> {
  await withTx(pool, async (c) => {
    const e = await lockEntry(c, id, body.version);
    if (e.status === 'draft') throw new HttpError(409, 'This entry is already a draft.');
    await c.query(`update time_entries set status = 'draft', version = version + 1, updated_at = now() where id = $1`, [id]);
    await audit(c, { subject_type: 'entry', subject_id: id, version: e.version + 1, actor, action: 'reopened', before: { status: e.status }, after: { status: 'draft' } });
    await recomputeDayFlags(c, e.day_id, ctx);
  });
}

/** The attorney places a queued activity: a matter, admin, personal or ignore. Same-thread queued emails follow. */
export async function resolveActivity(pool: Pool, activityId: string, choice: { matter_id: string } | { category: 'admin' | 'personal' | 'ignore' }, actor: string): Promise<{ dayId: string; matterId: string | null; activityIds: string[] }> {
  return withTx(pool, async (c) => {
    const found = await c.query<{ day_id: string; thread: string | null; status: string }>(
      `select a.day_id, a.meta->>'thread_id' as thread, am.status from activities a join activity_matches am on am.activity_id = a.id where a.id = $1 for update of am`,
      [activityId],
    );
    const row = found.rows[0];
    if (!row) throw new HttpError(404, 'That activity no longer exists.');
    if (row.status !== 'needs_review') throw new HttpError(409, 'That activity was already placed.');
    const siblings = row.thread
      ? await c.query<{ id: string }>(
          `select a.id from activities a join activity_matches am on am.activity_id = a.id
            where a.day_id = $1 and a.meta->>'thread_id' = $2 and am.status = 'needs_review'`,
          [row.day_id, row.thread],
        )
      : { rows: [{ id: activityId }] };
    const ids = [...new Set([activityId, ...siblings.rows.map((r) => r.id)])];
    const matterId = 'matter_id' in choice ? choice.matter_id : null;
    if (matterId) matterById(loadFirm(), matterId);
    const category: Category = matterId ? 'billable' : choice && 'category' in choice && choice.category !== 'ignore' ? choice.category : 'unknown';
    const status = 'category' in choice && choice.category === 'ignore' ? 'ignored' : 'resolved';
    for (const id of ids) {
      const before = await c.query('select matter_id, category, status from activity_matches where activity_id = $1', [id]);
      await c.query(`update activity_matches set matter_id = $2, category = $3, method = 'attorney', status = $4, updated_at = now() where activity_id = $1`, [id, matterId, category, status]);
      await audit(c, { subject_type: 'activity', subject_id: id, actor, action: 'resolved', before: before.rows[0], after: { matter_id: matterId, category, status } });
    }
    return { dayId: row.day_id, matterId, activityIds: ids };
  });
}

// ---------- read models for the review screen ----------

export interface EntryFlagView {
  code: string;
  severity: 'block' | 'warn';
  message: string;
  evidence: string[];
  override_reason: string | null;
}

export interface EntryView {
  id: string;
  matter_id: string;
  units_tenths: number;
  raw_seconds: number;
  task_code: string;
  activity_code: string;
  narrative: string;
  thin_context: boolean;
  billable: boolean;
  status: EntryStatus;
  origin: 'drafter' | 'attorney';
  why: string;
  prompt_version: string | null;
  version: number;
  first_at: string | null;
  source_count: number;
  flags: EntryFlagView[];
}

export interface QueueItem {
  activity_id: string;
  source: string;
  started_at: string;
  title: string;
  participants: string[];
  thread_id: string | null;
  suggestion: { matter_id: string; category: Category; confidence: number; evidence: string[]; why: string } | null;
}

export async function getEntryViews(db: Queryable, filter: { dayId: string } | { ids: string[] }): Promise<EntryView[]> {
  const byIds = 'ids' in filter;
  const rows = await db.query<EntryRow & { first_at: Date | null; source_count: number }>(
    `select e.*, s.first_at, coalesce(s.n, 0)::int as source_count
       from time_entries e
       left join lateral (select min(a.started_at) as first_at, count(*) as n
                            from entry_sources es join activities a on a.id = es.activity_id where es.entry_id = e.id) s on true
      where ${byIds ? 'e.id = any($1::uuid[])' : 'e.day_id = $1'}
      order by s.first_at nulls last, e.created_at`,
    [byIds ? filter.ids : filter.dayId],
  );
  const flags = await db.query<EntryFlagView & { entry_id: string }>(
    `select entry_id, code, severity, message, evidence, override_reason from entry_flags where entry_id = any($1::uuid[]) order by id`,
    [rows.rows.map((r) => r.id)],
  );
  const byEntry = new Map<string, EntryFlagView[]>();
  for (const f of flags.rows) byEntry.set(f.entry_id, [...(byEntry.get(f.entry_id) ?? []), { code: f.code, severity: f.severity, message: f.message, evidence: f.evidence, override_reason: f.override_reason }]);
  return rows.rows.map((r) => ({
    id: r.id,
    matter_id: r.matter_id,
    units_tenths: r.units_tenths,
    raw_seconds: r.raw_seconds,
    task_code: r.task_code,
    activity_code: r.activity_code,
    narrative: r.narrative,
    thin_context: r.thin_context,
    billable: r.billable,
    status: r.status,
    origin: r.origin,
    why: r.why,
    prompt_version: r.prompt_version,
    version: r.version,
    first_at: r.first_at ? r.first_at.toISOString() : null,
    source_count: r.source_count,
    flags: byEntry.get(r.id) ?? [],
  }));
}

function phoneNames(): Map<string, string> {
  const firm = loadFirm();
  const names = new Map<string, string>();
  for (const m of firm.matters) for (const p of m.parties) if (p.phone) names.set(p.phone, p.name);
  for (const c of firm.shared_contacts) names.set(c.phone, `${c.name}, ${c.org}`);
  for (const p of firm.firm.admin_phones) names.set(p, `${firm.firm.name} IT help desk`);
  return names;
}

export function activityTitle(source: string, body: string, meta: Record<string, unknown>, names = phoneNames()): string {
  if (source === 'email') return String(meta.subject ?? body.split('\n')[0]);
  if (source === 'calendar' || source === 'doc') return String(meta.title ?? body.split('\n')[0]);
  const number = String(meta.number ?? '');
  const who = names.get(number);
  return `${meta.direction === 'out' ? 'Call to' : 'Call from'} ${number}${who ? ` (${who})` : ''}`;
}

export async function getQueue(db: Queryable, dayId: string): Promise<QueueItem[]> {
  const names = phoneNames();
  const res = await db.query<{ id: string; source: string; started_at: Date; body: string; meta: Record<string, unknown>; participants: string[]; suggestion: QueueItem['suggestion'] }>(
    `select a.id, a.source, a.started_at, a.body, a.meta, a.participants, am.suggestion
       from activities a join activity_matches am on am.activity_id = a.id
      where a.day_id = $1 and am.status = 'needs_review' order by a.started_at`,
    [dayId],
  );
  return res.rows.map((r) => ({
    activity_id: r.id,
    source: r.source,
    started_at: r.started_at.toISOString(),
    title: activityTitle(r.source, r.body, r.meta, names),
    participants: r.participants,
    thread_id: (r.meta.thread_id as string | undefined) ?? null,
    suggestion: r.suggestion,
  }));
}

export async function getEntrySources(db: Queryable, entryId: string) {
  const names = phoneNames();
  const res = await db.query<{ activity_id: string; source: string; external_id: string; started_at: Date; est_seconds: number; duration_basis: string; seconds: number; body: string; meta: Record<string, unknown>; method: string | null; confidence: string | null; evidence: unknown[] | null }>(
    `select a.id as activity_id, a.source, a.external_id, a.started_at, a.est_seconds, a.duration_basis, es.seconds, a.body, a.meta,
            am.method, am.confidence, am.evidence
       from entry_sources es join activities a on a.id = es.activity_id
       left join activity_matches am on am.activity_id = a.id
      where es.entry_id = $1 order by a.started_at`,
    [entryId],
  );
  return res.rows.map((r) => ({
    activity_id: r.activity_id,
    source: r.source,
    external_id: r.external_id,
    started_at: r.started_at.toISOString(),
    est_seconds: r.est_seconds,
    duration_basis: r.duration_basis,
    seconds: r.seconds,
    title: activityTitle(r.source, r.body, r.meta, names),
    snippet: r.body.split('\n').filter((l) => !/^(Subject|From|To|Cc|Attachments):/.test(l)).join(' ').slice(0, 220),
    match: { method: r.method, confidence: r.confidence === null ? null : Number(r.confidence), evidence: r.evidence ?? [] },
  }));
}

export async function getEntryHistory(db: Queryable, entryId: string) {
  const res = await db.query<{ id: string; version: number | null; actor: string; action: string; before: unknown; after: unknown; reason: string | null; created_at: Date }>(
    `select id, version, actor, action, before, after, reason, created_at from audit_events where subject_type = 'entry' and subject_id = $1 order by id desc`,
    [entryId],
  );
  return res.rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() }));
}

export async function getDayView(db: Queryable, dayId: string, checker: GuidelineChecker) {
  const firm = loadFirm();
  const day = await db.query<{ id: string; fixture_id: string; work_date: string; status: string }>('select id, fixture_id, work_date, status from days where id = $1', [dayId]);
  if (!day.rowCount) throw new HttpError(404, 'That day has not been loaded.');
  const matters = await db.query<{ id: string; name: string; short_name: string; client_matter_id: string; profile: Profile }>(
    `select id, name, card->>'short_name' as short_name, client_matter_id, profile from matters order by id`,
  );
  const entries = await getEntryViews(db, { dayId });
  const queue = await getQueue(db, dayId);
  const nb = await db.query<{ id: string; source: string; body: string; meta: Record<string, unknown>; evidence: { signal: string; value?: string }[] }>(
    `select a.id, a.source, a.body, a.meta, am.evidence from activities a join activity_matches am on am.activity_id = a.id
      where a.day_id = $1 and am.status = 'ignored' and am.evidence @> '[{"signal":"not_billed"}]'`,
    [dayId],
  );
  const live = entries.filter((e) => e.status !== 'rejected');
  const { input } = await checkInputForDay(db, dayId, firm.words);
  const dayFlags = input.entries.length ? (await checker.check(input)).filter((f) => f.entry_id === null) : [];
  return {
    day: day.rows[0],
    attorney: { name: firm.attorney.name, display_name: firm.attorney.display_name, firm: firm.firm.name },
    matters: matters.rows,
    entries,
    queue,
    notBilled: nb.rows.map((r) => ({ activity_id: r.id, title: activityTitle(r.source, r.body, r.meta), reason: r.evidence.find((x) => x.signal === 'not_billed')?.value ?? '' })),
    totals: {
      billable_tenths: live.filter((e) => e.billable).reduce((s, e) => s + e.units_tenths, 0),
      non_billable_tenths: live.filter((e) => !e.billable).reduce((s, e) => s + e.units_tenths, 0),
      approved: entries.filter((e) => e.status === 'approved').length,
      drafts: entries.filter((e) => e.status === 'draft').length,
      rejected: entries.filter((e) => e.status === 'rejected').length,
      total: entries.length,
      queue: queue.length,
    },
    dayFlags,
    words: firm.words,
    profiles: input.profiles,
    daily_max_tenths: input.daily_max_tenths,
    checker: checker.name,
    llm: process.env.LLM_MODE ?? 'anthropic',
  };
}

export type DayView = Awaited<ReturnType<typeof getDayView>>;
