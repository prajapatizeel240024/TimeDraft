import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AnswerKeySchema, DayFixtureSchema } from '@/lib/schemas';
import { ACTIVITY_CODES, TASK_CODES } from '@/lib/utbms';

const days = fs.readdirSync('evals/days').filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', '')).sort();

describe('synthetic fixtures and answer keys', () => {
  it('has 12 days: 8 dev and 4 holdout', () => {
    expect(days).toHaveLength(12);
    const splits = days.map((d) => JSON.parse(fs.readFileSync(`evals/keys/${d}.key.json`, 'utf8')).split);
    expect(splits.filter((s) => s === 'dev')).toHaveLength(8);
  });
  for (const d of days) {
    it(`${d} validates and every activity is in its key`, () => {
      const fx = DayFixtureSchema.parse(JSON.parse(fs.readFileSync(`evals/days/${d}.json`, 'utf8')));
      const key = AnswerKeySchema.parse(JSON.parse(fs.readFileSync(`evals/keys/${d}.key.json`, 'utf8')));
      const ids = [...fx.emails, ...fx.calendar, ...fx.doc_sessions, ...fx.calls].map((a) => a.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(Object.keys(key.activities).sort()).toEqual([...ids].sort());
      expect(key.traps.length).toBeGreaterThanOrEqual(2);
      expect(key.traps.length).toBeLessThanOrEqual(4);
      for (const b of key.blocks.filter((x) => x.category === 'billable')) expect(b.matter_id).toMatch(/^M-100[123]$/);
    });
  }
  it('day 03 carries the four demo traps', () => {
    const kinds = JSON.parse(fs.readFileSync('evals/keys/day-03.key.json', 'utf8')).traps.map((t: { kind: string }) => t.kind).sort();
    expect(kinds).toEqual(['admin', 'duplicate_call', 'shared_expert', 'thin_context']);
  });
  it('db/seed/utbms.sql mirrors src/lib/utbms.ts', () => {
    const sql = fs.readFileSync('db/seed/utbms.sql', 'utf8');
    for (const c of [...TASK_CODES, ...ACTIVITY_CODES]) expect(sql).toContain(`('${c.code}', '${c.phase ? 'task' : 'activity'}', ${c.phase ? `'${c.phase}'` : 'null'}, '${c.label}')`);
    expect(sql.match(/\('[LA]\d{3}'/g)).toHaveLength(TASK_CODES.length + ACTIVITY_CODES.length);
  });
});
