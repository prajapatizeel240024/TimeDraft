// Matching: rules first, Claude for the rest, and a bar Claude's answers must clear. Anything below
// the bar goes to the review queue with Claude's suggestion attached. Never guess.
import type { Pool } from 'pg';
import type { FirmConfig } from '@/lib/config';
import type { Activity, Category, LLM, MatchAnswer, MatchItem, MatchStatus } from '@/lib/types';
import { withTx } from '@/server/db';
import { loadActivities } from '@/server/ingest/normalize';
import { buildMatchItems, quoteIsReal } from './llm';
import { CONFLICT_SCORE, ruleDecision, scoreActivity, type RuleResult } from './rules';

export interface Decision {
  status: MatchStatus;
  category: Category;
  matter_id: string | null;
  method: 'rule' | 'llm';
  confidence: number | null;
  evidence: unknown[];
  suggestion: MatchAnswer | null;
}

/** Pure: the same inputs always give the same decision, which is what lets the eval sweep thresholds. */
export function decide(rule: RuleResult, answer: MatchAnswer | null, item: MatchItem | null, threshold: number): Decision {
  const d = ruleDecision(rule);
  const ruleEvidence = rule.signals.map((s) => ({ signal: s.signal, value: s.value, weight: s.weight, matter_id: s.matter_id }));
  if (d.kind === 'excluded') return { status: 'ignored', category: 'unknown', matter_id: null, method: 'rule', confidence: null, evidence: [{ signal: d.reason }], suggestion: null };
  if (d.kind === 'personal') return { status: 'auto', category: 'personal', matter_id: null, method: 'rule', confidence: null, evidence: [{ signal: 'personal_word' }], suggestion: null };
  if (d.kind === 'auto') return { status: 'auto', category: 'billable', matter_id: d.matter_id, method: 'rule', confidence: d.score, evidence: ruleEvidence, suggestion: null };
  if (d.kind === 'admin') return { status: 'auto', category: 'admin', matter_id: null, method: 'rule', confidence: null, evidence: rule.adminEvidence.map((v) => ({ signal: 'admin', value: v })), suggestion: null };

  const queued: Decision = { status: 'needs_review', category: 'unknown', matter_id: null, method: 'llm', confidence: answer?.confidence ?? null, evidence: ruleEvidence, suggestion: answer };
  if (!answer || !item) return queued;
  const quotesReal = answer.evidence.length > 0 && answer.evidence.every((q) => quoteIsReal(q, item));
  const strongElsewhere = Object.entries(rule.scores).some(([id, score]) => score >= CONFLICT_SCORE && id !== answer.matter_id);
  if (answer.confidence < threshold || !quotesReal || strongElsewhere) return queued;
  const evidence = answer.evidence.map((q) => ({ signal: 'claude_quote', value: q }));
  if (answer.category === 'billable' && answer.matter_id !== 'NONE') {
    return { status: 'auto', category: 'billable', matter_id: answer.matter_id, method: 'llm', confidence: answer.confidence, evidence, suggestion: answer };
  }
  if ((answer.category === 'admin' || answer.category === 'personal') && answer.matter_id === 'NONE') {
    return { status: 'auto', category: answer.category, matter_id: null, method: 'llm', confidence: answer.confidence, evidence, suggestion: answer };
  }
  return queued;
}

export interface MatchRun {
  activities: Activity[];
  rules: Map<string, RuleResult>;
  items: Map<string, MatchItem>;
  answers: Map<string, MatchAnswer>;
  decisions: Map<string, Decision>;
}

export async function runMatching(pool: Pool, dayId: string, firm: FirmConfig, llm: LLM, threshold: number): Promise<MatchRun> {
  const activities = await loadActivities(pool, dayId);
  const rules = new Map(activities.map((a) => [a.id, scoreActivity(a, firm)]));
  const leftovers = activities.filter((a) => ruleDecision(rules.get(a.id)!).kind === 'claude');
  const itemList = buildMatchItems(leftovers, activities);
  const items = new Map(itemList.map((i) => [i.activity_id, i]));
  const answers = new Map<string, MatchAnswer>();
  if (itemList.length) {
    const byRef = new Map(itemList.map((i) => [i.ref, i.activity_id]));
    for (const ans of await llm.match(itemList)) {
      const id = byRef.get(ans.activity_ref);
      if (id && !answers.has(id)) answers.set(id, ans);
    }
  }
  const decisions = new Map(activities.map((a) => [a.id, decide(rules.get(a.id)!, answers.get(a.id) ?? null, items.get(a.id) ?? null, threshold)]));
  await withTx(pool, async (c) => {
    for (const a of activities) {
      const d = decisions.get(a.id)!;
      await c.query(
        `insert into activity_matches (activity_id, matter_id, category, method, confidence, evidence, suggestion, status, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8, now())
         on conflict (activity_id) do update set matter_id = excluded.matter_id, category = excluded.category, method = excluded.method,
           confidence = excluded.confidence, evidence = excluded.evidence, suggestion = excluded.suggestion, status = excluded.status, updated_at = now()
         where activity_matches.status <> 'resolved'`,
        [a.id, d.matter_id, d.category, d.method, d.confidence, JSON.stringify(d.evidence), d.suggestion ? JSON.stringify(d.suggestion) : null, d.status],
      );
    }
    const counts = { auto: 0, needs_review: 0, ignored: 0 } as Record<string, number>;
    for (const d of decisions.values()) counts[d.status] = (counts[d.status] ?? 0) + 1;
    await c.query(`insert into audit_events (subject_type, subject_id, actor, action, after) values ('day', $1, $2, 'matched', $3)`, [dayId, itemList.length ? `system+${llm.name}:match.v1` : 'system', counts]);
    await c.query(`update days set status = 'matched' where id = $1 and status in ('ingested','reconciled')`, [dayId]);
  });
  return { activities, rules, items, answers, decisions };
}
