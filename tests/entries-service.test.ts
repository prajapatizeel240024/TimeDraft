// Runs against the local eval database (reset here), with the answer-key stand-in instead of Claude.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadFirm } from '@/lib/config';
import { closePools, dbUrl, getPool, migrate, resetDb } from '@/server/db';
import { approveEntry, checkContext, editEntry, getEntryHistory, getEntryViews, rejectEntry, reopenEntry } from '@/server/entries/service';
import { exportMatterDay, parseLedes } from '@/server/export/ledes';
import { tsChecker } from '@/server/guidelines/index';
import { ingestFixture } from '@/server/ingest/normalize';
import { runDay, type PipelineEvent } from '@/server/pipeline';
import { loadFixture, oracleLLM } from '../evals/score';

const url = dbUrl('eval');
const pool = getPool(url);
const ctx = checkContext(tsChecker);
let dayId = '';

beforeAll(async () => {
  await migrate(url);
  await resetDb(url);
  ({ dayId } = await ingestFixture(pool, loadFixture('day-03'), loadFirm().attorney.id));
  await runDay(pool, dayId, () => undefined, { llm: oracleLLM(), checker: tsChecker, threshold: 0.8 });
});
afterAll(() => closePools());

const auditCount = async (id: string) => (await pool.query<{ n: number }>(`select count(*)::int as n from audit_events where subject_type = 'entry' and subject_id = $1`, [id])).rows[0].n;
const entryWhere = async (pred: (e: Awaited<ReturnType<typeof getEntryViews>>[number]) => boolean) => (await getEntryViews(pool, { dayId })).find(pred)!;

describe('entries service', () => {
  it('drafts entries with time from the sources, in whole tenths', async () => {
    const entries = await getEntryViews(pool, { dayId });
    expect(entries.length).toBeGreaterThanOrEqual(6);
    for (const e of entries) {
      expect(Number.isInteger(e.units_tenths)).toBe(true);
      expect(e.units_tenths).toBe(Math.ceil(e.raw_seconds / 360));
    }
    expect((await entryWhere((e) => e.narrative.includes('Notes.docx'))).flags.map((f) => f.code)).toContain('VAGUE_NARRATIVE');
  });

  it('writes exactly one audit row per edit, and clears the thin flag once the attorney supplies the purpose', async () => {
    const e = await entryWhere((x) => x.narrative.includes('Notes.docx'));
    const before = await auditCount(e.id);
    await editEntry(pool, e.id, { version: e.version, narrative: "Prepare outline for Rule 30(b)(6) deposition of Calder Freight Lines' corporate designee.", via: 'rewrite' }, 'attorney:DW', ctx);
    expect(await auditCount(e.id)).toBe(before + 1);
    const after = await entryWhere((x) => x.id === e.id);
    expect(after.thin_context).toBe(false);
    expect(after.flags.map((f) => f.code)).not.toContain('VAGUE_NARRATIVE');
    const [last] = await getEntryHistory(pool, e.id);
    expect(last).toMatchObject({ action: 'rewritten', actor: 'attorney:DW via claude:rewrite.v1' });
  });

  it('refuses a stale version with 409', async () => {
    const e = await entryWhere((x) => x.status === 'draft');
    await expect(editEntry(pool, e.id, { version: e.version - 1 || 99, units_tenths: 3 }, 'attorney:DW', ctx)).rejects.toMatchObject({ status: 409 });
  });

  it('needs a reason to approve an entry with a blocking flag', async () => {
    const e = await entryWhere((x) => x.status === 'draft');
    await editEntry(pool, e.id, { version: e.version, narrative: 'Reviewed file.' }, 'attorney:DW', ctx);
    const vague = await entryWhere((x) => x.id === e.id);
    expect(vague.flags.some((f) => f.severity === 'block')).toBe(true);
    await expect(approveEntry(pool, e.id, { version: vague.version }, 'attorney:DW')).rejects.toMatchObject({ status: 422 });
    await approveEntry(pool, e.id, { version: vague.version, override_reason: 'Client agreed to short narratives for this task.' }, 'attorney:DW');
    expect((await entryWhere((x) => x.id === e.id)).status).toBe('approved');
    await expect(editEntry(pool, e.id, { version: vague.version + 1, units_tenths: 2 }, 'attorney:DW', ctx)).rejects.toMatchObject({ status: 409 });
  });

  it('rejects and reopens, each with its own audit row', async () => {
    const e = await entryWhere((x) => x.status === 'draft');
    const n = await auditCount(e.id);
    await rejectEntry(pool, e.id, { version: e.version, reason: 'Duplicate of another entry.' }, 'attorney:DW', ctx);
    await reopenEntry(pool, e.id, { version: e.version + 1 }, 'attorney:DW', ctx);
    expect(await auditCount(e.id)).toBe(n + 2);
  });

  it('keeps the audit log append-only', async () => {
    await expect(pool.query(`update audit_events set actor = 'someone else'`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`delete from audit_events`)).rejects.toThrow(/append-only/);
  });

  it('exports approved billable entries as LEDES 1998B', async () => {
    const e = await entryWhere((x) => x.status === 'draft' && x.matter_id === 'M-1002' && !x.flags.some((f) => f.severity === 'block'));
    await approveEntry(pool, e.id, { version: e.version }, 'attorney:DW');
    const out = await exportMatterDay(pool, 'M-1002', dayId, 'attorney:DW');
    const { rows } = parseLedes(out.text);
    expect(out.invoiceNumber).toBe('TD-M1002-20260310');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0][23]).toBe('HT-LIT-0392');
    await expect(exportMatterDay(pool, 'M-1003', dayId, 'attorney:DW')).rejects.toMatchObject({ status: 422 });
  });

  it('gives concurrent exports of the same matter and day their own invoice numbers', async () => {
    const outs = await Promise.all([1, 2, 3].map(() => exportMatterDay(pool, 'M-1002', dayId, 'attorney:DW')));
    const numbers = outs.map((o) => o.invoiceNumber);
    expect(new Set(numbers).size).toBe(3);
    for (const n of numbers) expect(n).toMatch(/^TD-M1002-20260310-\d$/);
    const audited = await pool.query<{ n: number }>(`select count(*)::int as n from audit_events where subject_type = 'export' and action = 'exported'`);
    expect(audited.rows[0].n).toBe(4);
  });

  it('re-runs the stages a failed run missed', async () => {
    const deps = { llm: oracleLLM(), checker: tsChecker, threshold: 0.8 };
    const { dayId: id } = await ingestFixture(pool, loadFixture('day-06'), loadFirm().attorney.id);
    const stopAtReconcile = (e: PipelineEvent) => {
      if (e.type === 'stage' && e.stage === 'reconcile') throw new Error('stopped before reconcile');
    };
    const status = async () => (await pool.query<{ status: string }>('select status from days where id = $1', [id])).rows[0].status;
    await expect(runDay(pool, id, stopAtReconcile, deps)).rejects.toThrow('stopped before reconcile');
    expect(await status()).toBe('failed');
    await runDay(pool, id, () => undefined, deps);
    expect(await status()).toBe('drafted');
    const merged = await pool.query<{ n: number }>('select count(*)::int as n from activities where day_id = $1 and merged_into is not null', [id]);
    expect(merged.rows[0].n).toBe(1);
    const actions = await pool.query<{ action: string }>(`select action from audit_events where subject_type = 'day' and subject_id = $1 order by id`, [id]);
    expect(actions.rows.map((r) => r.action)).toEqual(['created', 'matched']);
  });
});
