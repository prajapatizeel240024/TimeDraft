import { describe, expect, it } from 'vitest';
import { entrySeconds, intervalsOf } from '@/server/time/intervals';

const at = (hhmm: string) => `2026-03-10T${hhmm}:00Z`;

describe('time inside an entry', () => {
  it('counts overlapping calls, meetings and doc sessions once', () => {
    const { total, perActivity } = entrySeconds([
      { id: 'doc', source: 'doc', started_at: at('10:00'), est_seconds: 3600 },
      { id: 'call', source: 'call', started_at: at('10:30'), est_seconds: 3600 },
    ]);
    expect(total).toBe(5400);
    expect(perActivity.get('doc')).toBe(3600);
    expect(perActivity.get('call')).toBe(1800);
  });
  it('adds email estimates on top, since emails have no reliable span', () => {
    const { total } = entrySeconds([
      { id: 'doc', source: 'doc', started_at: at('10:00'), est_seconds: 600 },
      { id: 'mail', source: 'email', started_at: at('10:05'), est_seconds: 240 },
    ]);
    expect(total).toBe(840);
  });
  it('gives zero to an interval fully inside another', () => {
    const { perActivity } = entrySeconds([
      { id: 'meeting', source: 'calendar', started_at: at('09:00'), est_seconds: 7200 },
      { id: 'inner', source: 'doc', started_at: at('09:30'), est_seconds: 600 },
    ]);
    expect(perActivity.get('inner')).toBe(0);
  });
  it('exposes intervals only for interval sources', () => {
    expect(intervalsOf([
      { id: 'a', source: 'call', started_at: at('10:00'), est_seconds: 60 },
      { id: 'b', source: 'email', started_at: at('10:00'), est_seconds: 60 },
    ])).toEqual([{ start: '2026-03-10T10:00:00.000Z', end: '2026-03-10T10:01:00.000Z' }]);
  });
});
