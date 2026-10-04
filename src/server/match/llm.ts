// Builds the leftover activities for Claude's matcher, with neighbors for context.
import type { Activity, MatchItem } from '@/lib/types';

const TZ = 'America/New_York';
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function localTime(isoTime: string, tz = TZ): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(isoTime));
}

/** Same email thread, or anything within 30 minutes: what a person would glance at to place an activity. */
export function neighborsOf(a: Activity, all: Activity[]): Activity[] {
  const t = Date.parse(a.started_at);
  const thread = a.meta.thread_id;
  return all
    .filter((b) => b.id !== a.id && !b.merged_into)
    .filter((b) => (thread && b.meta.thread_id === thread) || Math.abs(Date.parse(b.started_at) - t) <= 30 * 60 * 1000)
    .slice(0, 4);
}

export function buildMatchItems(leftovers: Activity[], all: Activity[]): MatchItem[] {
  return leftovers.map((a, i) => ({
    ref: `a${i + 1}`,
    activity_id: a.id,
    external_id: a.external_id,
    source: a.source,
    when: localTime(a.started_at),
    participants: a.participants,
    text: clip(a.body, 700),
    neighbors: neighborsOf(a, all).map((b) => ({ source: b.source, when: localTime(b.started_at), text: clip(b.body, 240) })),
  }));
}

const squash = (s: string) => s.toLowerCase().replace(/[“”"']/g, '').replace(/\s+/g, ' ').trim();

/** A quote counts only if it really appears in the activity, its participants or its neighbors. */
export function quoteIsReal(quote: string, item: MatchItem): boolean {
  const q = squash(quote);
  if (q.length < 3) return false;
  const haystack = squash([item.text, item.participants.join(' '), ...item.neighbors.map((n) => n.text)].join(' \n '));
  return haystack.includes(q);
}
