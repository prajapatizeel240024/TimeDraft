import { describe, expect, it } from 'vitest';
import { buildLedes, LEDES_FIELDS, lineTotalCents, parseLedes, type LedesInvoice } from '@/server/export/ledes';

const invoice: LedesInvoice = {
  invoiceDate: '2026-03-10',
  invoiceNumber: 'TD-M1001-20260310',
  clientId: 'KESTREL',
  lawFirmMatterId: 'M-1001',
  periodStart: '2026-03-10',
  periodEnd: '2026-03-10',
  description: 'Professional services',
  lawFirmId: '00-0000000',
  clientMatterId: 'KL-2026-014',
  timekeeper: { id: 'DW', name: 'Whitfield, Dana', classification: 'AS', rateCents: 45000 },
  lines: [
    { date: '2026-03-10', unitsTenths: 12, taskCode: 'L310', activityCode: 'A103', narrative: "Draft responses and objections to Calder Freight's First Set of Interrogatories (Nos. 1-9)." },
    { date: '2026-03-10', unitsTenths: 7, taskCode: 'L310', activityCode: 'A106', narrative: 'Telephone conference with J. Moss regarding draft interrogatory responses.' },
    { date: '2026-03-10', unitsTenths: 12, taskCode: 'L330', activityCode: 'A101', narrative: 'Prepare outline for Rule 30(b)(6) deposition | with a stray pipe\nand a line break' },
  ],
};

const GOLDEN = [
  'LEDES1998B[]',
  `${LEDES_FIELDS.join('|')}[]`,
  "20260310|TD-M1001-20260310|KESTREL|M-1001|1395.00|20260310|20260310|Professional services|1|F|1.2|0.00|540.00|20260310|L310||A103|DW|Draft responses and objections to Calder Freight's First Set of Interrogatories (Nos. 1-9).|00-0000000|450.00|Whitfield, Dana|AS|KL-2026-014[]",
  '20260310|TD-M1001-20260310|KESTREL|M-1001|1395.00|20260310|20260310|Professional services|2|F|0.7|0.00|315.00|20260310|L310||A106|DW|Telephone conference with J. Moss regarding draft interrogatory responses.|00-0000000|450.00|Whitfield, Dana|AS|KL-2026-014[]',
  '20260310|TD-M1001-20260310|KESTREL|M-1001|1395.00|20260310|20260310|Professional services|3|F|1.2|0.00|540.00|20260310|L330||A101|DW|Prepare outline for Rule 30(b)(6) deposition with a stray pipe and a line break|00-0000000|450.00|Whitfield, Dana|AS|KL-2026-014[]',
].join('\n') + '\n';

describe('LEDES 1998B', () => {
  it('matches the golden file byte for byte', () => expect(buildLedes(invoice).text).toBe(GOLDEN));
  it('has 24 fields per line and line totals that add up to the invoice total', () => {
    const { header, rows } = parseLedes(buildLedes(invoice).text);
    expect(header).toHaveLength(24);
    for (const r of rows) expect(r).toHaveLength(24);
    const sum = rows.reduce((s, r) => s + Math.round(Number(r[12]) * 100), 0);
    expect(sum).toBe(Math.round(Number(rows[0][4]) * 100));
    expect(buildLedes(invoice).totalCents).toBe(139500);
  });
  it('rounds line totals in integer cents', () => {
    expect(lineTotalCents(12, 45000)).toBe(54000);
    expect(lineTotalCents(1, 45555)).toBe(4556);
  });
  it('refuses an invoice number over 20 characters', () => expect(() => buildLedes({ ...invoice, invoiceNumber: 'TD-M1001-20260310-EXTRA' })).toThrow());
});
