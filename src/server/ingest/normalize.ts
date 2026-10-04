// Turns a day fixture into one activities row per email, calendar event, doc session and call,
// and reads activity rows back in the shape the rest of the server uses.
import type { Pool } from 'pg';
import type { Activity, DurationBasis, Source } from '@/lib/types';
import type { DayFixture } from '@/lib/schemas';
import { withTx, type Queryable } from '@/server/db';
import { audit } from '@/server/entries/service';
import { estimateReadEmail, estimateSentEmail } from './estimate';

export interface NormalizedActivity {
  source: Source;
  external_id: string;
  started_at: string;
  ended_at: string | null;
  est_seconds: number;
  duration_basis: DurationBasis;
  participants: string[];
  body: string;
  meta: Record<string, unknown>;
}

const utc = (isoTime: string, plusSeconds = 0) => new Date(Date.parse(isoTime) + plusSeconds * 1000).toISOString();
const lower = (xs: string[]) => [...new Set(xs.map((x) => x.trim().toLowerCase()).filter(Boolean))];

export function normalizeFixture(fx: DayFixture): NormalizedActivity[] {
  const out: NormalizedActivity[] = [];
  for (const e of fx.emails) {
    const attach = e.attachments.length ? `\nAttachments: ${e.attachments.join(', ')}` : '';
    const body = `Subject: ${e.subject}\nFrom: ${e.from}\nTo: ${e.to.join(', ')}${e.cc.length ? `\nCc: ${e.cc.join(', ')}` : ''}\n${e.body}${attach}`;
    const meta = { thread_id: e.thread_id, direction: e.direction, from: e.from, to: e.to, cc: e.cc, subject: e.subject, attachments: e.attachments, at: e.at };
    const participants = lower([e.from, ...e.to, ...e.cc]);
    if (e.direction === 'sent') {
      const est = estimateSentEmail(e.body, e.attachments.length);
      out.push({ source: 'email', external_id: e.id, started_at: utc(e.at, -est), ended_at: utc(e.at), est_seconds: est, duration_basis: 'estimated', participants, body, meta });
    } else {
      const opened = e.opened_at !== '';
      const est = estimateReadEmail(e.body, opened);
      const start = opened ? e.opened_at : e.at;
      out.push({ source: 'email', external_id: e.id, started_at: utc(start), ended_at: utc(start, est), est_seconds: est, duration_basis: opened ? 'estimated' : 'none', participants, body, meta: { ...meta, opened } });
    }
  }
  for (const c of fx.calendar) {
    const scheduled = Math.round((Date.parse(c.end) - Date.parse(c.start)) / 1000);
    const attended = c.response !== 'declined';
    out.push({
      source: 'calendar',
      external_id: c.id,
      started_at: utc(c.start),
      ended_at: utc(c.end),
      est_seconds: attended ? scheduled : 0,
      duration_basis: attended ? 'scheduled' : 'none',
      participants: lower(c.attendees),
      body: `${c.title}${c.description ? `\n${c.description}` : ''}`,
      meta: { title: c.title, response: c.response, attendees: c.attendees, description: c.description },
    });
  }
  for (const d of fx.doc_sessions) {
    out.push({ source: 'doc', external_id: d.id, started_at: utc(d.start), ended_at: utc(d.end), est_seconds: d.active_seconds, duration_basis: 'measured', participants: [], body: `${d.title}\n${d.path}`, meta: { path: d.path, title: d.title } });
  }
  for (const p of fx.calls) {
    out.push({
      source: 'call',
      external_id: p.id,
      started_at: utc(p.start),
      ended_at: utc(p.start, p.duration_seconds),
      est_seconds: p.duration_seconds,
      duration_basis: 'exact',
      participants: [p.number],
      body: `Phone call ${p.direction === 'in' ? 'from' : 'to'} ${p.number}`,
      meta: { number: p.number, direction: p.direction },
    });
  }
  return out.sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
}

/** Loads a fixture into days + activities. Loading the same fixture twice is a no-op. */
export async function ingestFixture(pool: Pool, fx: DayFixture, attorneyId: string): Promise<{ dayId: string; created: boolean }> {
  return withTx(pool, async (c) => {
    const ins = await c.query<{ id: string }>(
      `insert into days (fixture_id, attorney_id, work_date) values ($1, $2, $3)
       on conflict (fixture_id) do nothing returning id`,
      [fx.day_id, attorneyId, fx.date],
    );
    if (!ins.rowCount) {
      const existing = await c.query<{ id: string }>('select id from days where fixture_id = $1', [fx.day_id]);
      return { dayId: existing.rows[0].id, created: false };
    }
    const dayId = ins.rows[0].id;
    for (const a of normalizeFixture(fx)) {
      await c.query(
        `insert into activities (day_id, source, external_id, started_at, ended_at, est_seconds, duration_basis, participants, body, meta)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [dayId, a.source, a.external_id, a.started_at, a.ended_at, a.est_seconds, a.duration_basis, a.participants, a.body, a.meta],
      );
    }
    await audit(c, { subject_type: 'day', subject_id: dayId, actor: 'system', action: 'created', after: { fixture_id: fx.day_id, work_date: fx.date } });
    return { dayId, created: true };
  });
}

interface ActivityRow extends Omit<Activity, 'started_at' | 'ended_at'> {
  started_at: Date;
  ended_at: Date | null;
}

const toActivity = (r: ActivityRow): Activity => ({ ...r, started_at: r.started_at.toISOString(), ended_at: r.ended_at ? r.ended_at.toISOString() : null });

export async function loadActivities(db: Queryable, dayId: string): Promise<Activity[]> {
  const res = await db.query<ActivityRow>('select * from activities where day_id = $1 order by started_at, external_id', [dayId]);
  return res.rows.map(toActivity);
}

export async function loadActivitiesById(db: Queryable, ids: string[]): Promise<Activity[]> {
  if (!ids.length) return [];
  const res = await db.query<ActivityRow>('select * from activities where id = any($1::uuid[]) order by started_at', [ids]);
  return res.rows.map(toActivity);
}
