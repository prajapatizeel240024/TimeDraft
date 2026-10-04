// Checks Claude's draft: every activity placed exactly once, ids and codes valid. Claude never returns
// time, so nothing here reads a duration. Also finds names in a narrative that no source mentions.
import type { DraftActivity, DraftOutput, Words } from '@/lib/types';
import { isActivityCode, isTaskCode, normalizeCode } from '@/lib/utbms';

export interface ValidEntry {
  refs: string[];
  task_code: string;
  activity_code: string;
  narrative: string;
  thin: boolean;
  why: string;
}

export interface Validation {
  errors: string[];
  entries: ValidEntry[];
  notBilled: { ref: string; reason: string }[];
  unplaced: string[];
}

export function validateDraft(out: DraftOutput, activities: DraftActivity[]): Validation {
  const known = new Set(activities.map((a) => a.ref));
  const placed = new Set<string>();
  const errors: string[] = [];
  const entries: ValidEntry[] = [];
  const notBilled: { ref: string; reason: string }[] = [];

  out.entries.forEach((e, i) => {
    const task = normalizeCode(e.task_code);
    const act = normalizeCode(e.activity_code);
    if (!isTaskCode(task)) errors.push(`Entry ${i + 1} has unknown task code ${e.task_code}.`);
    if (!isActivityCode(act)) errors.push(`Entry ${i + 1} has unknown activity code ${e.activity_code}.`);
    const refs: string[] = [];
    for (const r of e.activity_refs) {
      if (!known.has(r)) errors.push(`Entry ${i + 1} lists ${r}, which isn't one of the activities.`);
      else if (placed.has(r)) errors.push(`${r} appears in more than one place.`);
      else {
        placed.add(r);
        refs.push(r);
      }
    }
    const words = e.narrative.trim().split(/\s+/).length;
    if (words > 60) errors.push(`Entry ${i + 1}'s narrative is ${words} words; keep it under 35.`);
    if (refs.length && isTaskCode(task) && isActivityCode(act)) entries.push({ refs, task_code: task, activity_code: act, narrative: e.narrative.trim(), thin: e.thin, why: e.why.trim() });
  });
  for (const nb of out.not_billed) {
    if (!known.has(nb.activity_ref)) errors.push(`not_billed lists ${nb.activity_ref}, which isn't one of the activities.`);
    else if (placed.has(nb.activity_ref)) errors.push(`${nb.activity_ref} appears in more than one place.`);
    else {
      placed.add(nb.activity_ref);
      notBilled.push({ ref: nb.activity_ref, reason: nb.reason });
    }
  }
  const unplaced = activities.map((a) => a.ref).filter((r) => !placed.has(r));
  if (unplaced.length) errors.push(`These activities aren't placed anywhere: ${unplaced.join(', ')}.`);
  return { errors, entries, notBilled, unplaced };
}

/** Capitalized names in the narrative that appear in no source and not in the matter card. */
export function ungroundedTerms(narrative: string, sourceTexts: string[], matterText: string, words: Words): string[] {
  const generic = new Set(words.generic_caps);
  const haystack = [...sourceTexts, matterText].join('\n').toLowerCase();
  const out: string[] = [];
  for (const token of narrative.split(/\s+/).slice(1)) {
    const clean = token
      .replace(/^[^A-Za-z]+/, '')
      .replace(/['’]s\b.*$/, '')
      .replace(/\.(docx?|pdf|xlsx?|pptx?)$/i, '')
      .replace(/[^A-Za-z0-9-]+$/, '');
    if (!/^[A-Z][A-Za-z-]{2,}$/.test(clean) || generic.has(clean)) continue;
    if (!haystack.includes(clean.toLowerCase())) out.push(clean);
  }
  return [...new Set(out)];
}
