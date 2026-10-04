import { describe, expect, it } from 'vitest';
import { loadFirm } from '@/lib/config';
import type { DraftActivity } from '@/lib/types';
import { ungroundedTerms, validateDraft } from '@/server/draft/validate';

const acts: DraftActivity[] = ['d1', 'd2', 'd3'].map((ref) => ({ ref, activity_id: ref, external_id: ref, source: 'email', start: '09:00', est_minutes: 3, text: 'x' }));
const entry = (refs: string[], o = {}) => ({ activity_refs: refs, task_code: 'L310', activity_code: 'A103', narrative: 'Draft responses to Calder interrogatories for client review', thin: false, why: 'One drafting task.', ...o });

describe('draft validation', () => {
  it('accepts every activity placed exactly once', () => {
    const v = validateDraft({ entries: [entry(['d1', 'd2'])], not_billed: [{ activity_ref: 'd3', reason: 'Automated notice.' }] }, acts);
    expect(v.errors).toEqual([]);
    expect(v.entries[0].refs).toEqual(['d1', 'd2']);
  });
  it('reports unplaced, unknown and duplicate activities', () => {
    const v = validateDraft({ entries: [entry(['d1', 'd9']), entry(['d1'])], not_billed: [] }, acts);
    expect(v.unplaced).toEqual(['d2', 'd3']);
    expect(v.errors.join(' ')).toMatch(/d9/);
    expect(v.errors.join(' ')).toMatch(/more than one place/);
  });
  it('compares codes case-insensitively and rejects unknown codes', () => {
    expect(validateDraft({ entries: [entry(['d1', 'd2', 'd3'], { task_code: 'l310', activity_code: 'a103' })], not_billed: [] }, acts).entries[0].task_code).toBe('L310');
    expect(validateDraft({ entries: [entry(['d1', 'd2', 'd3'], { task_code: 'L999' })], not_billed: [] }, acts).errors[0]).toMatch(/L999/);
  });
  it('sends the activities of an entry dropped for a bad code back as unplaced', () => {
    const v = validateDraft({ entries: [entry(['d1', 'd2'], { task_code: 'L999' }), entry(['d3'])], not_billed: [] }, acts);
    expect(v.entries.map((e) => e.refs)).toEqual([['d3']]);
    expect(v.errors.join(' ')).toMatch(/L999/);
    expect(v.errors.join(' ')).not.toMatch(/aren't placed/);
    expect(v.unplaced).toEqual(['d1', 'd2']);
  });
  it('finds names that no source mentions', () => {
    const words = loadFirm().words;
    expect(ungroundedTerms('Correspond with J. Moss regarding Hendricks deposition', ['jmoss@kestrel.example dispatch logs'], 'Janet Moss (client contact)', words)).toEqual(['Hendricks']);
    expect(ungroundedTerms("Review Calder Freight's First Set of Interrogatories", ['Calder Freight Lines'], '', words)).toEqual([]);
  });
});
