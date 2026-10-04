import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadFirm } from '@/lib/config';
import type { Activity } from '@/lib/types';
import { normalizeFixture } from '@/server/ingest/normalize';
import { findCallMerges, phoneDirectory } from '@/server/ingest/reconcile';

const acts = (day: string): Activity[] =>
  normalizeFixture(JSON.parse(fs.readFileSync(`evals/days/${day}.json`, 'utf8'))).map((a) => ({ ...a, id: a.external_id, day_id: day, merged_into: null }));
const phones = phoneDirectory(loadFirm());

describe('reconcile', () => {
  it('merges the planted calendar + call duplicate on every day that has one', () => {
    for (const day of ['day-03', 'day-06', 'day-09', 'day-12']) {
      const key = JSON.parse(fs.readFileSync(`evals/keys/${day}.key.json`, 'utf8'));
      const trap = key.traps.find((t: { kind: string }) => t.kind === 'duplicate_call');
      const merges = findCallMerges(acts(day), phones);
      expect(merges).toHaveLength(1);
      expect(trap.activity_ids.sort()).toEqual([merges[0].calendarId, merges[0].callId].sort());
    }
  });
  it('leaves phone-only calls alone', () => {
    expect(findCallMerges(acts('day-01'), phones)).toHaveLength(0);
  });
  it('needs the number to belong to an attendee', () => {
    const list = acts('day-03');
    const call = list.find((a) => a.source === 'call')!;
    call.meta = { ...call.meta, number: '+1-212-555-0199' };
    call.participants = ['+1-212-555-0199'];
    expect(findCallMerges(list, phones)).toHaveLength(0);
  });
  it('skips what it already merged, so a second run changes nothing', () => {
    const list = acts('day-03');
    const call = list.find((a) => a.id === 'd03p01')!;
    // A callback from the same number 8 minutes later: the first call is closer to the meeting, so it stays unmerged.
    list.push({ ...call, id: 'callback', external_id: 'callback', started_at: new Date(Date.parse(call.started_at) + 8 * 60_000).toISOString() });
    const [m] = findCallMerges(list, phones);
    expect(m).toEqual({ calendarId: 'd03c01', callId: 'd03p01' });
    // Apply the merge the way reconcileDay does, then run again.
    const ev = list.find((a) => a.id === m.calendarId)!;
    Object.assign(ev, { started_at: call.started_at, meta: { ...ev.meta, merged_call: call.external_id } });
    call.merged_into = ev.id;
    expect(findCallMerges(list, phones)).toEqual([]);
  });
});
