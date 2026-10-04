import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadFirm } from '@/lib/config';
import type { Activity, MatchAnswer, MatchItem } from '@/lib/types';
import { normalizeFixture } from '@/server/ingest/normalize';
import { findCallMerges, phoneDirectory } from '@/server/ingest/reconcile';
import { decide } from '@/server/match/index';
import { hasTerm, ruleDecision, scoreActivity } from '@/server/match/rules';

const firm = loadFirm();
const days = fs.readdirSync('evals/days').map((f) => f.replace('.json', '')).sort();

function dayActivities(day: string): Activity[] {
  const list = normalizeFixture(JSON.parse(fs.readFileSync(`evals/days/${day}.json`, 'utf8'))).map((a) => ({ ...a, id: a.external_id, day_id: day, merged_into: null as string | null }));
  for (const m of findCallMerges(list, phoneDirectory(firm))) list.find((a) => a.id === m.callId)!.merged_into = m.calendarId;
  return list;
}

describe('rule matching on all 12 synthetic days', () => {
  it('never auto-matches an activity to the wrong matter', () => {
    let auto = 0;
    for (const day of days) {
      const key = JSON.parse(fs.readFileSync(`evals/keys/${day}.key.json`, 'utf8'));
      const blocks = new Map(key.blocks.map((b: { id: string }) => [b.id, b]));
      for (const a of dayActivities(day)) {
        const d = ruleDecision(scoreActivity(a, firm));
        if (d.kind !== 'auto') continue;
        auto += 1;
        const block = blocks.get(key.activities[a.id].block_id) as { matter_id: string } | undefined;
        expect(block?.matter_id, `${day} ${a.id}`).toBe(d.matter_id);
      }
    }
    expect(auto).toBeGreaterThan(80);
  });
  it('sends the planted hard cases to Claude instead of guessing', () => {
    for (const day of days) {
      const key = JSON.parse(fs.readFileSync(`evals/keys/${day}.key.json`, 'utf8'));
      const hard = new Set(key.traps.filter((t: { kind: string }) => ['shared_expert', 'internal_email'].includes(t.kind)).flatMap((t: { activity_ids: string[] }) => t.activity_ids));
      for (const a of dayActivities(day).filter((x) => hard.has(x.id))) expect(ruleDecision(scoreActivity(a, firm)).kind, `${day} ${a.id}`).toBe('claude');
    }
  });
  it('matches terms on word boundaries', () => {
    expect(hasTerm('Call w/ Janet Moss', 'Moss')).toBe(true);
    expect(hasTerm('Mossberg filings', 'Moss')).toBe(false);
    expect(hasTerm('Rule 30(b)(6) notice', '30(b)(6)')).toBe(true);
  });
});

describe('the bar Claude must clear', () => {
  const leftover = dayActivities('day-03').find((a) => a.id === 'd03e05')!; // Lena Park: "Imaging timeline"
  const rule = scoreActivity(leftover, firm);
  const item: MatchItem = { ref: 'a1', activity_id: leftover.id, external_id: leftover.id, source: 'email', when: '10:00', participants: leftover.participants, text: leftover.body, neighbors: [] };
  const answer = (o: Partial<MatchAnswer>): MatchAnswer => ({ activity_ref: 'a1', matter_id: 'M-1002', category: 'billable', confidence: 0.92, evidence: ['image the laptop'], why: 'Laptop imaging is the Halberd matter.', ...o });

  it('accepts a confident answer whose quotes really appear', () => expect(decide(rule, answer({}), item, 0.8)).toMatchObject({ status: 'auto', matter_id: 'M-1002', method: 'llm' }));
  it('queues a low-confidence answer', () => expect(decide(rule, answer({ confidence: 0.62 }), item, 0.8).status).toBe('needs_review'));
  it('queues an answer with an invented quote', () => expect(decide(rule, answer({ evidence: ['the TRO hearing'] }), item, 0.8).status).toBe('needs_review'));
  it('queues an answer with no quotes', () => expect(decide(rule, answer({ evidence: [] }), item, 0.8).status).toBe('needs_review'));
  it('queues when Claude gives no answer', () => expect(decide(rule, null, item, 0.8).status).toBe('needs_review'));
  it('keeps the suggestion when it queues', () => expect(decide(rule, answer({ confidence: 0.5 }), item, 0.8).suggestion?.matter_id).toBe('M-1002'));
});
