// Time inside an entry: calls, meetings and doc sessions are merged by union so overlaps count once;
// emails have no reliable span, so their estimates are added on top.
import type { Source } from '@/lib/types';

export interface TimedSource {
  id: string;
  source: Source;
  started_at: string;
  est_seconds: number;
}

export function isIntervalSource(source: Source): boolean {
  return source === 'calendar' || source === 'doc' || source === 'call';
}

export function entrySeconds(sources: TimedSource[]): { total: number; perActivity: Map<string, number> } {
  const perActivity = new Map<string, number>();
  const spans = sources
    .filter((s) => isIntervalSource(s.source) && s.est_seconds > 0)
    .map((s) => {
      const start = Math.floor(Date.parse(s.started_at) / 1000);
      return { id: s.id, start, end: start + s.est_seconds };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let coveredUntil = Number.NEGATIVE_INFINITY;
  for (const s of spans) {
    perActivity.set(s.id, Math.max(0, s.end - Math.max(s.start, coveredUntil)));
    coveredUntil = Math.max(coveredUntil, s.end);
  }
  for (const s of sources) if (!perActivity.has(s.id)) perActivity.set(s.id, isIntervalSource(s.source) ? 0 : s.est_seconds);
  let total = 0;
  for (const v of perActivity.values()) total += v;
  return { total, perActivity };
}

export function intervalsOf(sources: TimedSource[]): { start: string; end: string }[] {
  return sources
    .filter((s) => isIntervalSource(s.source) && s.est_seconds > 0)
    .map((s) => ({ start: new Date(Date.parse(s.started_at)).toISOString(), end: new Date(Date.parse(s.started_at) + s.est_seconds * 1000).toISOString() }));
}
