// Rule matching: free, fast and explainable. Each signal adds a weight to a matter, and weights
// combine as 1 - (1 - w1)(1 - w2)..., so two medium signals beat one. Claude only sees what's left.
import type { FirmConfig, Matter } from '@/lib/config';
import type { Activity } from '@/lib/types';

export const WEIGHTS = {
  matter_number: 0.95,
  doc_folder: 0.9,
  client_domain: 0.8,
  contact_phone: 0.8,
  party_domain: 0.75,
  client_name: 0.7,
  party_name: 0.6,
  shared_contact: 0.4,
  keyword: 0.3,
} as const;
export const AUTO_SCORE = 0.85;
export const AUTO_LEAD = 0.3;
export const CONFLICT_SCORE = 0.6;

export type SignalName = keyof typeof WEIGHTS;
export interface Signal {
  matter_id: string;
  signal: SignalName;
  value: string;
  weight: number;
}

export interface RuleResult {
  exclusion: null | 'merged' | 'declined' | 'no_time';
  personal: boolean;
  admin: boolean;
  adminEvidence: string[];
  signals: Signal[];
  scores: Record<string, number>;
  top: { matter_id: string; score: number } | null;
  second: number;
}

export type RuleDecision =
  | { kind: 'excluded'; reason: string }
  | { kind: 'personal' }
  | { kind: 'admin' }
  | { kind: 'auto'; matter_id: string; score: number }
  | { kind: 'claude' };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Case-insensitive term match: whole words when the term starts and ends with a letter or digit, substring otherwise. */
export function hasTerm(text: string, term: string): boolean {
  const t = term.trim();
  if (!t) return false;
  if (/^[A-Za-z0-9].*[A-Za-z0-9]$|^[A-Za-z0-9]$/.test(t)) return new RegExp(`\\b${escapeRe(t)}\\b`, 'i').test(text);
  return text.toLowerCase().includes(t.toLowerCase());
}

const domainOf = (address: string) => (address.includes('@') ? address.split('@')[1].toLowerCase() : '');

function matterSignals(a: Activity, m: Matter, firm: FirmConfig): Signal[] {
  const out: Signal[] = [];
  const add = (signal: SignalName, value: string) => out.push({ matter_id: m.id, signal, value, weight: WEIGHTS[signal] });
  const text = a.body;
  const digits = m.id.replace(/\D/g, '');
  if (new RegExp(`\\bM-?${digits}\\b`, 'i').test(text)) add('matter_number', m.id);
  const docPath = String(a.meta.path ?? '').toLowerCase();
  for (const folder of m.doc_folders) if (docPath && docPath.startsWith(folder.toLowerCase())) add('doc_folder', folder);
  const domains = a.participants.map(domainOf).filter(Boolean);
  for (const d of m.client.domains) if (domains.includes(d.toLowerCase())) add('client_domain', d);
  for (const p of m.parties) {
    if (p.phone && a.participants.includes(p.phone)) add('contact_phone', `${p.name} ${p.phone}`);
    if (p.role !== 'client_contact') for (const d of p.domains) if (domains.includes(d.toLowerCase())) add('party_domain', d);
    if (p.email && p.role !== 'client_contact' && a.participants.includes(p.email.toLowerCase())) add('party_domain', p.email);
    for (const name of [p.name, ...p.aliases]) if (hasTerm(text, name)) add('party_name', name);
  }
  for (const name of [m.client.name, ...m.client.aliases]) if (hasTerm(text, name)) add('client_name', name);
  for (const c of firm.shared_contacts) {
    if (!c.matters.includes(m.id)) continue;
    if (a.participants.includes(c.email.toLowerCase()) || a.participants.includes(c.phone)) add('shared_contact', c.name);
  }
  for (const k of m.keywords) if (hasTerm(text, k)) add('keyword', k);
  return out;
}

/** Noisy-OR over the strongest signal of each kind, so ten keyword hits can't add up to certainty. */
function combine(signals: Signal[]): number {
  const best = new Map<SignalName, number>();
  for (const s of signals) best.set(s.signal, Math.max(best.get(s.signal) ?? 0, s.weight));
  let miss = 1;
  for (const w of best.values()) miss *= 1 - w;
  return Math.round((1 - miss) * 1000) / 1000;
}

export function scoreActivity(a: Activity, firm: FirmConfig): RuleResult {
  const result: RuleResult = { exclusion: null, personal: false, admin: false, adminEvidence: [], signals: [], scores: {}, top: null, second: 0 };
  if (a.merged_into) return { ...result, exclusion: 'merged' };
  if (a.source === 'calendar' && a.meta.response === 'declined') return { ...result, exclusion: 'declined' };
  if (a.est_seconds <= 0) return { ...result, exclusion: 'no_time' };

  for (const m of firm.matters) {
    const signals = matterSignals(a, m, firm);
    result.signals.push(...signals);
    result.scores[m.id] = combine(signals);
  }
  const ranked = Object.entries(result.scores).sort((x, y) => y[1] - x[1]);
  if (ranked.length && ranked[0][1] > 0) result.top = { matter_id: ranked[0][0], score: ranked[0][1] };
  result.second = ranked[1]?.[1] ?? 0;

  const topScore = result.top?.score ?? 0;
  if (a.source === 'calendar' && topScore < CONFLICT_SCORE) {
    result.personal = firm.words.personal.some((w) => hasTerm(String(a.meta.title ?? a.body), w));
  }
  const sender = String(a.meta.from ?? '').toLowerCase();
  if (firm.firm.admin_senders.includes(sender)) result.adminEvidence.push(`from ${sender}`);
  for (const phone of firm.firm.admin_phones) if (a.participants.includes(phone)) result.adminEvidence.push(`call with ${phone}`);
  for (const w of firm.words.admin) if (hasTerm(a.body, w)) result.adminEvidence.push(w);
  result.admin = result.adminEvidence.length > 0 && topScore < CONFLICT_SCORE;
  return result;
}

export function ruleDecision(r: RuleResult): RuleDecision {
  if (r.exclusion) return { kind: 'excluded', reason: r.exclusion };
  if (r.personal) return { kind: 'personal' };
  if (r.top && r.top.score >= AUTO_SCORE && r.top.score - r.second >= AUTO_LEAD) return { kind: 'auto', matter_id: r.top.matter_id, score: r.top.score };
  if (r.admin) return { kind: 'admin' };
  return { kind: 'claude' };
}
