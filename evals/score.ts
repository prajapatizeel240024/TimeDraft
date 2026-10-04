// Everything that reads answer keys: loading fixtures and keys, the oracle stand-in, and scoring.
// The oracle answers from the keys so the pipeline and the scorer can be tested without Claude.
// It is never a result: reports label it, and the review screen footer shows it.
import fs from 'node:fs';
import path from 'node:path';
import type { DraftRequest, LLM, MatchItem, RewriteRequest } from '@/lib/types';
import { AnswerKeySchema, DayFixtureSchema, type AnswerKey, type DayFixture } from '@/lib/schemas';

type Block = AnswerKey['blocks'][number];
const dir = (sub: string) => path.join(process.cwd(), 'evals', sub);

export function listDays(split: 'dev' | 'holdout' | 'all' = 'all'): string[] {
  return fs
    .readdirSync(dir('days'))
    .filter((f) => /^day-\d{2}\.json$/.test(f))
    .map((f) => f.replace('.json', ''))
    .sort()
    .filter((d) => split === 'all' || loadKey(d).split === split);
}
export function loadFixture(dayId: string): DayFixture {
  return DayFixtureSchema.parse(JSON.parse(fs.readFileSync(path.join(dir('days'), `${dayId}.json`), 'utf8')));
}
export function loadKey(dayId: string): AnswerKey {
  return AnswerKeySchema.parse(JSON.parse(fs.readFileSync(path.join(dir('keys'), `${dayId}.key.json`), 'utf8')));
}

let index: Map<string, Block | null> | null = null;
function blockFor(externalId: string): Block | null | undefined {
  if (!index) {
    index = new Map();
    for (const d of listDays()) {
      const key = loadKey(d);
      const blocks = new Map(key.blocks.map((b) => [b.id, b]));
      for (const [id, v] of Object.entries(key.activities)) index.set(id, v.block_id ? blocks.get(v.block_id) ?? null : null);
    }
  }
  return index.get(externalId);
}

const META = { promptVersion: 'oracle', model: 'answer-key' };

export function oracleLLM(): LLM {
  return {
    name: 'oracle',
    async match(items: MatchItem[]) {
      return items.map((i) => {
        const b = blockFor(i.external_id);
        const quote = i.text.split('\n')[0].slice(0, 40).trim();
        if (!b) return { activity_ref: i.ref, matter_id: 'NONE', category: 'unknown' as const, confidence: 0.2, evidence: [quote], why: 'Not work in the answer key.' };
        if (b.category === 'billable') return { activity_ref: i.ref, matter_id: b.matter_id ?? 'NONE', category: 'billable' as const, confidence: 0.95, evidence: [quote], why: 'From the answer key.' };
        return { activity_ref: i.ref, matter_id: 'NONE', category: b.category, confidence: 0.95, evidence: [quote], why: 'From the answer key.' };
      });
    },
    async draft(req: DraftRequest) {
      const groups = new Map<string, { block: Block; refs: string[] }>();
      const notBilled: { activity_ref: string; reason: string }[] = [];
      for (const a of req.activities) {
        const b = blockFor(a.external_id);
        if (!b || b.category !== 'billable') notBilled.push({ activity_ref: a.ref, reason: 'Not billable work in the answer key.' });
        else groups.set(b.id, { block: b, refs: [...(groups.get(b.id)?.refs ?? []), a.ref] });
      }
      const entries = [...groups.values()].map(({ block, refs }) => ({ activity_refs: refs, task_code: block.task_code, activity_code: block.activity_code, narrative: block.draft_narrative, thin: block.thin, why: 'Grouped from the answer key.' }));
      return { entries, not_billed: notBilled, meta: META };
    },
    async rewrite(req: RewriteRequest) {
      const b = req.sources.map((s) => blockFor(s.external_id)).find((x): x is Block => Boolean(x));
      if (!b || (b.thin && !req.hint.trim())) return { status: 'needs_detail' as const, narrative: '', question: b ? 'What were these notes for?' : 'What was this work for?', facts_used: [], meta: META };
      const facts = [{ activity_ref: req.sources[0]?.ref ?? 'matter', fact: b.draft_narrative }, ...(req.hint.trim() ? [{ activity_ref: 'hint', fact: req.hint.trim() }] : [])];
      return { status: 'rewritten' as const, narrative: b.summary, question: '', facts_used: facts, meta: META };
    },
  };
}

// ---------- scoring ----------

export interface Snapshot {
  activities: { external_id: string; merged_into: string | null; est_seconds: number }[];
  matches: Map<string, { status: string; category: string; matter_id: string | null }>;
  entries: { id: string; matter_id: string; raw_seconds: number; units_tenths: number; task_code: string; activity_code: string; billable: boolean; status: string; origin: string; sources: string[]; flags: { code: string; severity: string }[] }[];
}

export interface DayScore {
  day: string;
  activities: number;
  auto: number;
  correctAuto: number;
  queued: number;
  crossClient: { activity: string; predicted: string; expected: string }[];
  nonBillableBilled: number;
  adminExpected: number;
  adminCaught: number;
  personalExpected: number;
  personalCaught: number;
  trueSeconds: number;
  trueObservableSeconds: number;
  capturedSeconds: number;
  leakSeconds: number;
  overSeconds: number;
  billedTenths: number;
  trueTenths: number;
  paired: number;
  taskCorrect: number;
  activityCorrect: number;
  blocksWithEntries: number;
  blocksOneEntry: number;
  splits: number;
  merges: number;
  drafted: number;
  draftedVague: number;
  ungrounded: number;
  traps: { kind: string; passed: boolean; detail: string }[];
  falseFlags: number;
}

type Predicted = { kind: 'billable'; matter: string } | { kind: 'admin' | 'personal' | 'excluded' | 'queued' | 'unknown' };

function predicted(m: { status: string; category: string; matter_id: string | null } | undefined): Predicted {
  if (!m) return { kind: 'unknown' };
  if (m.status === 'needs_review') return { kind: 'queued' };
  if (m.status === 'ignored') return { kind: 'excluded' };
  if (m.category === 'billable' && m.matter_id) return { kind: 'billable', matter: m.matter_id };
  if (m.category === 'admin' || m.category === 'personal') return { kind: m.category };
  return { kind: 'unknown' };
}

const label = (p: Predicted) => (p.kind === 'billable' ? p.matter : p.kind);

export function scoreDay(dayId: string, key: AnswerKey, snap: Snapshot): DayScore {
  const blocks = new Map(key.blocks.map((b) => [b.id, b]));
  const expectedOf = (ext: string) => {
    const id = key.activities[ext]?.block_id;
    return id ? blocks.get(id) ?? null : null;
  };
  const live = snap.activities.filter((a) => !a.merged_into);
  const s: DayScore = { day: dayId, activities: live.length, auto: 0, correctAuto: 0, queued: 0, crossClient: [], nonBillableBilled: 0, adminExpected: 0, adminCaught: 0, personalExpected: 0, personalCaught: 0, trueSeconds: 0, trueObservableSeconds: 0, capturedSeconds: 0, leakSeconds: 0, overSeconds: 0, billedTenths: 0, trueTenths: 0, paired: 0, taskCorrect: 0, activityCorrect: 0, blocksWithEntries: 0, blocksOneEntry: 0, splits: 0, merges: 0, drafted: 0, draftedVague: 0, ungrounded: 0, traps: [], falseFlags: 0 };

  for (const a of live) {
    const b = expectedOf(a.external_id);
    const p = predicted(snap.matches.get(a.external_id));
    if (b?.category === 'admin') {
      s.adminExpected += 1;
      if (p.kind === 'admin') s.adminCaught += 1;
    }
    if (b?.category === 'personal') {
      s.personalExpected += 1;
      if (p.kind === 'personal' || p.kind === 'excluded') s.personalCaught += 1;
    }
    if (p.kind === 'queued') {
      s.queued += 1;
      continue;
    }
    s.auto += 1;
    const right = b === null ? p.kind === 'excluded' : b.category === 'billable' ? p.kind === 'billable' && p.matter === b.matter_id : p.kind === b.category || (b.category === 'personal' && p.kind === 'excluded');
    if (right) s.correctAuto += 1;
    if (p.kind === 'billable' && b?.category === 'billable' && b.matter_id !== p.matter) s.crossClient.push({ activity: a.external_id, predicted: p.matter, expected: b.matter_id ?? '-' });
    if (p.kind === 'billable' && (!b || b.category !== 'billable')) s.nonBillableBilled += 1;
  }

  // Time per matter: captured from billable, non-rejected entries; true from the key's billable blocks.
  const liveEntries = snap.entries.filter((e) => e.status !== 'rejected' && e.billable);
  for (const m of new Set(key.blocks.filter((b) => b.category === 'billable').map((b) => b.matter_id!))) {
    const truth = key.blocks.filter((b) => b.category === 'billable' && b.matter_id === m);
    const t = truth.reduce((x, b) => x + b.true_seconds, 0);
    const tObs = truth.filter((b) => b.signal !== 'none').reduce((x, b) => x + b.true_seconds, 0);
    const c = liveEntries.filter((e) => e.matter_id === m).reduce((x, e) => x + e.raw_seconds, 0);
    s.trueSeconds += t;
    s.trueObservableSeconds += tObs;
    s.capturedSeconds += c;
    s.leakSeconds += Math.max(0, tObs - c);
    s.overSeconds += Math.max(0, c - tObs);
    s.trueTenths += truth.reduce((x, b) => x + Math.ceil(b.true_seconds / 360), 0);
  }
  s.billedTenths = liveEntries.reduce((x, e) => x + e.units_tenths, 0);

  // Pair entries with blocks by shared activities (Jaccard >= 0.5).
  const blockActs = new Map<string, Set<string>>();
  for (const a of live) {
    const b = expectedOf(a.external_id);
    if (b && b.category === 'billable' && a.est_seconds > 0) blockActs.set(b.id, new Set([...(blockActs.get(b.id) ?? []), a.external_id]));
  }
  const trapBlocks = new Set(key.traps.flatMap((t) => t.activity_ids.map((id) => key.activities[id]?.block_id).filter((x): x is string => Boolean(x))));
  for (const e of snap.entries.filter((x) => x.status !== 'rejected')) {
    const set = new Set(e.sources);
    const touched = new Set(e.sources.map((x) => key.activities[x]?.block_id).filter((x): x is string => Boolean(x)));
    if (touched.size > 1) s.merges += 1;
    let best: { id: string; j: number } | null = null;
    for (const [bid, acts] of blockActs) {
      const inter = [...acts].filter((x) => set.has(x)).length;
      const j = inter / new Set([...acts, ...set]).size;
      if (j > (best?.j ?? 0)) best = { id: bid, j };
    }
    if (e.origin === 'drafter') {
      s.drafted += 1;
      if (e.flags.some((f) => f.code === 'VAGUE_NARRATIVE')) s.draftedVague += 1;
      if (e.flags.some((f) => f.code === 'UNGROUNDED_TERM')) s.ungrounded += 1;
    }
    if (best && best.j >= 0.5) {
      const b = blocks.get(best.id)!;
      s.paired += 1;
      if (e.task_code === b.task_code) s.taskCorrect += 1;
      if (e.activity_code === b.activity_code) s.activityCorrect += 1;
      if (!trapBlocks.has(b.id)) s.falseFlags += e.flags.filter((f) => f.severity === 'block' && f.code !== 'UNGROUNDED_TERM').length;
    }
  }
  for (const [, acts] of blockActs) {
    const holders = new Set(snap.entries.filter((e) => e.status !== 'rejected' && e.sources.some((x) => acts.has(x))).map((e) => e.id));
    if (!holders.size) continue;
    s.blocksWithEntries += 1;
    if (holders.size === 1 && snap.entries.some((e) => holders.has(e.id) && [...acts].every((x) => e.sources.includes(x)))) s.blocksOneEntry += 1;
    if (holders.size > 1) s.splits += 1;
  }

  // Planted traps.
  const entryWith = (ext: string) => snap.entries.find((e) => e.sources.includes(ext));
  for (const t of key.traps) {
    const first = t.activity_ids[0];
    const exp = expectedOf(first);
    const preds = t.activity_ids.map((id) => predicted(snap.matches.get(id)));
    let passed = false;
    let detail = '';
    if (t.kind === 'duplicate_call') {
      const merged = snap.activities.filter((a) => t.activity_ids.includes(a.external_id) && a.merged_into);
      passed = merged.length === 1;
      detail = passed ? 'merged into one activity' : 'not merged';
    } else if (t.kind === 'shared_expert' || t.kind === 'internal_email' || t.kind === 'phone_only') {
      passed = preds.every((p) => p.kind === 'queued' || (p.kind === 'billable' && p.matter === exp?.matter_id));
      detail = preds.map(label).join(', ');
    } else if (t.kind === 'admin') {
      passed = t.activity_ids.every((id) => {
        const p = predicted(snap.matches.get(id));
        const e = entryWith(id);
        return p.kind === 'admin' || p.kind === 'excluded' || (e ? e.flags.some((f) => f.code === 'NON_BILLABLE_ADMIN') : false);
      });
      detail = preds.map(label).join(', ');
    } else if (t.kind === 'personal' || t.kind === 'declined') {
      passed = preds.every((p) => p.kind === 'personal' || p.kind === 'excluded');
      detail = preds.map(label).join(', ');
    } else if (t.kind === 'long_block' || t.kind === 'thin_context') {
      const code = t.kind === 'long_block' ? 'LONG_ENTRY' : 'VAGUE_NARRATIVE';
      const e = entryWith(first);
      passed = Boolean(e?.flags.some((f) => f.code === code));
      detail = e ? (passed ? `${code} raised` : `no ${code}`) : 'no entry drafted';
    }
    s.traps.push({ kind: t.kind, passed, detail });
  }
  return s;
}
