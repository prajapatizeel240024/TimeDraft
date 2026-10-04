// Merges a calendar event and the call log for the same call into one activity with the real duration.
import type { Pool } from 'pg';
import type { FirmConfig } from '@/lib/config';
import type { Activity } from '@/lib/types';
import { withTx } from '@/server/db';
import { loadActivities } from './normalize';

const WINDOW_SECONDS = 10 * 60;

/** phone number -> contact emails, from every party and shared contact in the config. */
export function phoneDirectory(firm: FirmConfig): Map<string, string[]> {
  const dir = new Map<string, string[]>();
  const add = (phone?: string, email?: string) => {
    if (phone && email) dir.set(phone, [...(dir.get(phone) ?? []), email.toLowerCase()]);
  };
  for (const m of firm.matters) for (const p of m.parties) add(p.phone, p.email);
  for (const c of firm.shared_contacts) add(c.phone, c.email);
  return dir;
}

export function findCallMerges(activities: Activity[], phones: Map<string, string[]>): { calendarId: string; callId: string }[] {
  // An event that already took a call's time is done, so running reconcile again changes nothing.
  const events = activities.filter((a) => a.source === 'calendar' && a.est_seconds > 0 && !a.merged_into && !a.meta.merged_call);
  const calls = activities.filter((a) => a.source === 'call' && !a.merged_into);
  const merges: { calendarId: string; callId: string }[] = [];
  const used = new Set<string>();
  for (const ev of events) {
    let best: { id: string; gap: number } | null = null;
    for (const call of calls) {
      if (used.has(call.id)) continue;
      const emails = phones.get(String(call.meta.number ?? '')) ?? [];
      if (!emails.some((e) => ev.participants.includes(e))) continue;
      const gap = Math.abs(Date.parse(call.started_at) - Date.parse(ev.started_at)) / 1000;
      if (gap <= WINDOW_SECONDS && (!best || gap < best.gap)) best = { id: call.id, gap };
    }
    if (best) {
      used.add(best.id);
      merges.push({ calendarId: ev.id, callId: best.id });
    }
  }
  return merges;
}

export async function reconcileDay(pool: Pool, dayId: string, firm: FirmConfig): Promise<{ merged: number }> {
  const activities = await loadActivities(pool, dayId);
  const merges = findCallMerges(activities, phoneDirectory(firm));
  const byId = new Map(activities.map((a) => [a.id, a]));
  await withTx(pool, async (c) => {
    for (const m of merges) {
      const call = byId.get(m.callId)!;
      const ev = byId.get(m.calendarId)!;
      await c.query(
        `update activities set started_at = $2, ended_at = $3, est_seconds = $4, duration_basis = 'exact',
           participants = $5, meta = meta || $6 where id = $1`,
        [ev.id, call.started_at, call.ended_at, call.est_seconds, [...new Set([...ev.participants, ...call.participants])], { merged_call: call.external_id, number: call.meta.number, scheduled_seconds: ev.est_seconds }],
      );
      await c.query('update activities set merged_into = $2 where id = $1', [call.id, ev.id]);
    }
    await c.query(`update days set status = 'reconciled' where id = $1 and status in ('ingested','failed')`, [dayId]);
  });
  return { merged: merges.length };
}
