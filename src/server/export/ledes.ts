// LEDES 1998B export: one invoice per matter from approved, billable entries. Pipe-delimited, every line
// ends in "[]", 24 fields in spec order. Money is integer cents until it's formatted.
import type { Pool } from 'pg';
import { loadFirm } from '@/lib/config';
import { withTx } from '@/server/db';
import { HttpError } from '@/server/entries/service';
import { formatHours } from '@/server/time/rounding';

export const LEDES_FIELDS = [
  'INVOICE_DATE', 'INVOICE_NUMBER', 'CLIENT_ID', 'LAW_FIRM_MATTER_ID', 'INVOICE_TOTAL', 'BILLING_START_DATE', 'BILLING_END_DATE', 'INVOICE_DESCRIPTION',
  'LINE_ITEM_NUMBER', 'EXP/FEE/INV_ADJ_TYPE', 'LINE_ITEM_NUMBER_OF_UNITS', 'LINE_ITEM_ADJUSTMENT_AMOUNT', 'LINE_ITEM_TOTAL', 'LINE_ITEM_DATE', 'LINE_ITEM_TASK_CODE',
  'LINE_ITEM_EXPENSE_CODE', 'LINE_ITEM_ACTIVITY_CODE', 'TIMEKEEPER_ID', 'LINE_ITEM_DESCRIPTION', 'LAW_FIRM_ID', 'LINE_ITEM_UNIT_COST', 'TIMEKEEPER_NAME',
  'TIMEKEEPER_CLASSIFICATION', 'CLIENT_MATTER_ID',
] as const;

export interface LedesInvoice {
  invoiceDate: string; // YYYY-MM-DD
  invoiceNumber: string; // 20 characters max
  clientId: string;
  lawFirmMatterId: string;
  periodStart: string;
  periodEnd: string;
  description: string;
  lawFirmId: string;
  clientMatterId: string;
  timekeeper: { id: string; name: string; classification: string; rateCents: number };
  lines: { date: string; unitsTenths: number; taskCode: string; activityCode: string; narrative: string }[];
}

const ymd = (d: string) => d.replace(/-/g, '');
export const money = (cents: number) => `${cents < 0 ? '-' : ''}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;
const clean = (s: string) => s.replace(/\[\]/g, '').replace(/[|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Tenths x hourly rate in cents / 10. Exact for whole-dollar rates; rounds half up otherwise. */
export function lineTotalCents(unitsTenths: number, rateCents: number): number {
  return Math.round((unitsTenths * rateCents) / 10);
}

export function buildLedes(inv: LedesInvoice): { text: string; totalCents: number } {
  if (inv.invoiceNumber.length > 20) throw new Error(`INVOICE_NUMBER "${inv.invoiceNumber}" is over 20 characters`);
  const totals = inv.lines.map((l) => lineTotalCents(l.unitsTenths, inv.timekeeper.rateCents));
  const totalCents = totals.reduce((a, b) => a + b, 0);
  const rows = inv.lines.map((l, i) =>
    [
      ymd(inv.invoiceDate), inv.invoiceNumber, inv.clientId, inv.lawFirmMatterId, money(totalCents), ymd(inv.periodStart), ymd(inv.periodEnd), clean(inv.description),
      String(i + 1), 'F', formatHours(l.unitsTenths), '0.00', money(totals[i]), ymd(l.date), l.taskCode, '', l.activityCode, inv.timekeeper.id,
      clean(l.narrative), inv.lawFirmId, money(inv.timekeeper.rateCents), clean(inv.timekeeper.name), inv.timekeeper.classification, inv.clientMatterId,
    ].join('|') + '[]',
  );
  return { text: ['LEDES1998B[]', `${LEDES_FIELDS.join('|')}[]`, ...rows].join('\n') + '\n', totalCents };
}

/** Reads a LEDES 1998B file back into fields, for tests and for checking an export. */
export function parseLedes(text: string): { header: string[]; rows: string[][] } {
  const lines = text.split('\n').filter(Boolean);
  if (lines[0] !== 'LEDES1998B[]') throw new Error('Missing LEDES1998B[] first line');
  const fields = (l: string) => {
    if (!l.endsWith('[]')) throw new Error(`Line doesn't end in []: ${l.slice(0, 40)}`);
    return l.slice(0, -2).split('|');
  };
  return { header: fields(lines[1]), rows: lines.slice(2).map(fields) };
}

export async function exportMatterDay(pool: Pool, matterId: string, dayId: string, actor: string): Promise<{ filename: string; text: string; invoiceNumber: string }> {
  const firm = loadFirm();
  const matter = await pool.query<{ id: string; ledes_client_id: string; client_matter_id: string }>('select id, ledes_client_id, client_matter_id from matters where id = $1', [matterId]);
  if (!matter.rowCount) throw new HttpError(404, `Unknown matter ${matterId}.`);
  const day = await pool.query<{ work_date: string }>('select work_date from days where id = $1', [dayId]);
  if (!day.rowCount) throw new HttpError(404, 'That day has not been loaded.');
  const entries = await pool.query<{ id: string; work_date: string; units_tenths: number; task_code: string; activity_code: string; narrative: string }>(
    `select e.id, e.work_date, e.units_tenths, e.task_code, e.activity_code, e.narrative
       from time_entries e
       left join lateral (select min(a.started_at) as first_at from entry_sources es join activities a on a.id = es.activity_id where es.entry_id = e.id) s on true
      where e.day_id = $1 and e.matter_id = $2 and e.status = 'approved' and e.billable
      order by s.first_at nulls last, e.created_at`,
    [dayId, matterId],
  );
  if (!entries.rowCount) throw new HttpError(422, 'Approve at least one billable entry for this matter before exporting.');
  const date = day.rows[0].work_date;
  const base = `TD-${matterId.replace('-', '')}-${ymd(date)}`;
  const taken = await pool.query<{ n: number }>(`select count(*)::int as n from exports where invoice_number like $1`, [`${base}%`]);
  const invoiceNumber = taken.rows[0].n ? `${base}-${taken.rows[0].n + 1}` : base;
  const { text, totalCents } = buildLedes({
    invoiceDate: date,
    invoiceNumber,
    clientId: matter.rows[0].ledes_client_id,
    lawFirmMatterId: matterId,
    periodStart: date,
    periodEnd: date,
    description: 'Professional services',
    lawFirmId: firm.firm.ledes_firm_id,
    clientMatterId: matter.rows[0].client_matter_id,
    timekeeper: { id: firm.attorney.id, name: firm.attorney.name, classification: firm.attorney.classification, rateCents: firm.attorney.rate_cents },
    lines: entries.rows.map((e) => ({ date: e.work_date, unitsTenths: e.units_tenths, taskCode: e.task_code, activityCode: e.activity_code, narrative: e.narrative })),
  });
  await withTx(pool, async (c) => {
    const ins = await c.query<{ id: string }>(
      `insert into exports (matter_id, invoice_number, period_start, period_end, entry_ids, total_cents, file_text) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [matterId, invoiceNumber, date, date, entries.rows.map((e) => e.id), totalCents, text],
    );
    await c.query(`insert into audit_events (subject_type, subject_id, actor, action, after) values ('export', $1, $2, 'exported', $3)`, [ins.rows[0].id, actor, JSON.stringify({ invoice_number: invoiceNumber, matter_id: matterId, entries: entries.rowCount, total_cents: totalCents })]);
  });
  return { filename: `${invoiceNumber}.txt`, text, invoiceNumber };
}
