import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CheckEntry, Profile, Words } from '@/lib/types';
import { checkEntries, clauses, lastWord, verbOf } from '@/server/guidelines/rules';

interface Fixture {
  profiles: Record<string, Profile>;
  words: Words;
  daily_max_tenths: number;
  cases: { name: string; entries: CheckEntry[]; expect: { entry_id: string | null; code: string; severity?: string }[] }[];
}
const fx = JSON.parse(fs.readFileSync('contracts/fixtures/guidelines.json', 'utf8')) as Fixture;

describe('guideline checker matches the shared golden fixtures', () => {
  for (const c of fx.cases) {
    it(c.name, () => {
      const flags = checkEntries({ profiles: fx.profiles, words: fx.words, daily_max_tenths: fx.daily_max_tenths, entries: c.entries });
      const got = flags.map((f) => `${f.entry_id ?? 'day'}:${f.code}`).sort();
      const want = c.expect.map((x) => `${x.entry_id ?? 'day'}:${x.code}`).sort();
      expect(got).toEqual(want);
      for (const x of c.expect.filter((x) => x.severity)) {
        expect(flags.find((f) => f.entry_id === x.entry_id && f.code === x.code)?.severity).toBe(x.severity);
      }
    });
  }
});

describe('checker helpers', () => {
  const verbs = new Set(fx.words.task_verbs);
  it('maps simple verb forms back to the task verb', () => {
    expect(['reviewed', 'drafted', 'revised', 'conferred', 'preparing', 'calls', 'telephoned'].map((w) => verbOf(w, verbs))).toEqual(['review', 'draft', 'revise', 'confer', 'prepare', 'call', 'telephone']);
    expect(verbOf('objections', verbs)).toBeNull();
  });
  it('splits clauses on semicolons, commas and "and"', () => {
    expect(clauses('Draft motion; call client, review logs and email Janet')).toEqual(['Draft motion', 'call client', 'review logs', 'email Janet']);
  });
  it('strips punctuation and file extensions from the last word', () => {
    expect(lastWord('Revise Notes.docx.')).toBe('notes');
    expect(lastWord('Attend hearing (Part 12).')).toBe('12');
  });
});

describe('interval times', () => {
  const [e1, e2] = fx.cases.find((c) => c.name === 'overlap: two entries share 30 minutes')!.entries;
  const check = (start: string) =>
    checkEntries({ profiles: fx.profiles, words: fx.words, daily_max_tenths: fx.daily_max_tenths, entries: [e1, { ...e2, intervals: [{ start, end: '2026-03-10T15:30:00Z' }] }] });
  it('reads RFC 3339 times with an offset and fractional seconds', () => {
    expect(check('2026-03-10T10:30:00.000-04:00').map((f) => f.code)).toEqual(['OVERLAP', 'OVERLAP']);
  });
  it("rejects anything that isn't a strict RFC 3339 time", () => {
    for (const bad of ['2026-03-10 14:30:00Z', '2026-03-10T14:30:00', '2026-04-31T14:30:00Z', '2026-02-29T14:30:00Z', '2026-13-10T14:30:00Z', '2026-03-10T24:00:00Z', 'not a time', '']) {
      expect(() => check(bad), bad).toThrow(/bad interval time/);
    }
  });
});
