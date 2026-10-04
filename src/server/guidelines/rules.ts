// Billing guideline rules. Pure functions: no database, no network, no server imports, so the review
// screen runs them in the browser as the attorney types and checker-go mirrors them line for line.
// Words are data (config/firm.yaml); rules are code. contracts/fixtures/guidelines.json pins the behavior.
import type { CheckEntry, CheckInput, Flag, Words } from '@/lib/types';

export const COMM_CODES = ['A105', 'A106', 'A107', 'A108'];
export const OVERLAP_LIMIT_SECONDS = 15 * 60;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fmt = (tenths: number) => `${Math.floor(tenths / 10)}.${tenths % 10}`;

export function normalizeSpace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Case-insensitive whole-phrase match. Phrases in the word lists start and end with a letter. */
export function containsPhrase(text: string, phrase: string): boolean {
  return new RegExp(`\\b${escapeRe(phrase)}\\b`, 'i').test(text);
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((t) => /[A-Za-z0-9]/.test(t)).length;
}

/** Maps a word to a task verb, allowing simple past, -ing and -s forms: "reviewed" -> "review". */
export function verbOf(word: string, verbs: Set<string>): string | null {
  const w = word.toLowerCase();
  if (verbs.has(w)) return w;
  const candidates: string[] = [];
  if (w.endsWith('ed')) candidates.push(w.slice(0, -2), w.slice(0, -1), w.slice(0, -3));
  if (w.endsWith('ing')) candidates.push(w.slice(0, -3), `${w.slice(0, -3)}e`, w.slice(0, -4));
  if (w.endsWith('s')) candidates.push(w.slice(0, -1));
  for (const c of candidates) if (c && verbs.has(c)) return c;
  return null;
}

export function clauses(narrative: string): string[] {
  return normalizeSpace(narrative)
    .split(/;|,|\band\b/i)
    .map((c) => c.trim())
    .filter(Boolean);
}

function firstWord(clause: string): string | null {
  const m = clause.match(/^[A-Za-z]+/);
  return m ? m[0] : null;
}

/** The last word with trailing punctuation and a file extension removed: "Revise Notes.docx." -> "notes". */
export function lastWord(narrative: string): string {
  const trimmed = normalizeSpace(narrative).replace(/[^A-Za-z0-9]+$/, '');
  const tokens = trimmed.split(' ');
  const last = (tokens[tokens.length - 1] ?? '').replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '').toLowerCase();
  return last.replace(/\.(docx?|pdf|xlsx?|pptx?|txt|msg|eml|zip|csv)$/, '');
}

/** A role word, an initial plus surname ("J. Moss"), or a capitalized word that isn't a generic legal term. */
export function hasCounterparty(narrative: string, words: Words): boolean {
  const n = normalizeSpace(narrative);
  if (words.role_words.some((r) => containsPhrase(n, r))) return true;
  if (/\b[A-Z]\.\s?[A-Z][A-Za-z'-]+/.test(n)) return true;
  const generic = new Set(words.generic_caps);
  for (const token of n.split(' ').slice(1)) {
    const m = token.replace(/^[^A-Za-z]+/, '').match(/^[A-Z][a-z]+/);
    if (m && !generic.has(m[0])) return true;
  }
  return false;
}

function blockBilling(e: CheckEntry, words: Words, severity: 'warn' | 'block'): Flag | null {
  const verbs = new Set(words.task_verbs.map((v) => v.toLowerCase()));
  const found: { verb: string; clause: string }[] = [];
  for (const c of clauses(e.narrative)) {
    const w = firstWord(c);
    const v = w ? verbOf(w, verbs) : null;
    if (v) found.push({ verb: v, clause: c });
  }
  const distinct = [...new Set(found.map((f) => f.verb))];
  if (distinct.length < 2) return null;
  const pairs = new Set(words.same_task_pairs.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]));
  for (let i = 0; i < distinct.length; i++) {
    for (let j = i + 1; j < distinct.length; j++) {
      if (!pairs.has(`${distinct[i]}|${distinct[j]}`)) {
        return { entry_id: e.id, code: 'BLOCK_BILLING', severity, message: `Several tasks in one entry: ${distinct.join(', ')}.`, evidence: found.map((f) => f.clause) };
      }
    }
  }
  return null;
}

function vague(e: CheckEntry, words: Words, minWords: number): Flag | null {
  const n = normalizeSpace(e.narrative);
  const reasons: string[] = [];
  if (e.thin_context) reasons.push("The sources don't say what this work was for.");
  for (const p of words.vague_phrases) if (containsPhrase(n, p)) reasons.push(`Vague phrase "${p}".`);
  const count = wordCount(n);
  if (count < minWords) reasons.push(`Only ${count} words; this client expects at least ${minWords}.`);
  const last = lastWord(n);
  if (last && words.generic_objects.includes(last)) reasons.push(`Ends on a generic object ("${last}").`);
  if (COMM_CODES.includes(e.activity_code) && !hasCounterparty(n, words)) reasons.push("Doesn't say who the communication was with.");
  if (!reasons.length) return null;
  return { entry_id: e.id, code: 'VAGUE_NARRATIVE', severity: 'block', message: reasons.join(' '), evidence: reasons };
}

function longEntry(e: CheckEntry, maxTenths: number, commMax: number): Flag | null {
  const reasons: string[] = [];
  if (e.units_tenths > maxTenths) reasons.push(`${fmt(e.units_tenths)} h is over this client's ${fmt(maxTenths)} h limit per entry.`);
  if (COMM_CODES.includes(e.activity_code) && e.units_tenths > commMax) reasons.push(`${fmt(e.units_tenths)} h of communication is over the ${fmt(commMax)} h limit.`);
  if (!reasons.length) return null;
  return { entry_id: e.id, code: 'LONG_ENTRY', severity: 'warn', message: reasons.join(' '), evidence: reasons };
}

function adminTime(e: CheckEntry, words: Words): Flag | null {
  if (!e.billable) return null;
  const hits = words.admin.filter((w) => containsPhrase(e.narrative, w));
  if (e.source_categories.includes('admin')) hits.push('built from administrative activity');
  if (!hits.length) return null;
  return { entry_id: e.id, code: 'NON_BILLABLE_ADMIN', severity: 'block', message: 'Administrative work is not billable. Mark it non-billable or rewrite it.', evidence: hits };
}

function overlapSeconds(a: CheckEntry, b: CheckEntry): number {
  let total = 0;
  for (const x of a.intervals) {
    for (const y of b.intervals) {
      const start = Math.max(Date.parse(x.start), Date.parse(y.start));
      const end = Math.min(Date.parse(x.end), Date.parse(y.end));
      if (end > start) total += (end - start) / 1000;
    }
  }
  return Math.round(total);
}

export function checkEntries(input: CheckInput): Flag[] {
  const flags: Flag[] = [];
  for (const e of input.entries) {
    const profile = input.profiles[e.profile];
    if (!profile) throw new Error(`Unknown profile "${e.profile}" on entry ${e.id}`);
    for (const f of [blockBilling(e, input.words, profile.block_billing), vague(e, input.words, profile.min_words), longEntry(e, profile.max_entry_tenths, profile.comm_max_tenths), adminTime(e, input.words)]) {
      if (f) flags.push(f);
    }
  }
  const billable = input.entries.filter((e) => e.billable);
  for (let i = 0; i < billable.length; i++) {
    for (let j = i + 1; j < billable.length; j++) {
      const secs = overlapSeconds(billable[i], billable[j]);
      if (secs > OVERLAP_LIMIT_SECONDS) {
        const minutes = Math.round(secs / 60);
        flags.push({ entry_id: billable[i].id, code: 'OVERLAP', severity: 'warn', message: `Overlaps another entry by ${minutes} min.`, evidence: [billable[j].id, String(minutes)] });
        flags.push({ entry_id: billable[j].id, code: 'OVERLAP', severity: 'warn', message: `Overlaps another entry by ${minutes} min.`, evidence: [billable[i].id, String(minutes)] });
      }
    }
  }
  const total = billable.reduce((s, e) => s + e.units_tenths, 0);
  if (total > input.daily_max_tenths) {
    flags.push({ entry_id: null, code: 'DAILY_TOTAL', severity: 'warn', message: `Billable total of ${fmt(total)} h is above ${fmt(input.daily_max_tenths)} h for one day.`, evidence: [fmt(total)] });
  }
  return flags;
}
