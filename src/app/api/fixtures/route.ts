import fs from 'node:fs';
import path from 'node:path';
import { DayFixtureSchema } from '@/lib/schemas';
import { getPool } from '@/server/db';
import { jsonError } from '@/server/pipeline';

export const dynamic = 'force-dynamic';

/** The synthetic days on disk, with whether each one is loaded yet. */
export async function GET() {
  try {
    const dir = path.join(process.cwd(), 'evals', 'days');
    const loaded = await getPool().query<{ fixture_id: string; id: string; status: string; billable_tenths: number }>(
      `select d.fixture_id, d.id, d.status, coalesce(sum(e.units_tenths) filter (where e.billable and e.status <> 'rejected'), 0)::int as billable_tenths
         from days d left join time_entries e on e.day_id = d.id group by d.id`,
    );
    const byFixture = new Map(loaded.rows.map((r) => [r.fixture_id, r]));
    const days = fs
      .readdirSync(dir)
      .filter((f) => /^day-\d{2}\.json$/.test(f))
      .sort()
      .map((f) => {
        const fx = DayFixtureSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
        const row = byFixture.get(fx.day_id);
        return {
          fixture_id: fx.day_id,
          date: fx.date,
          counts: { emails: fx.emails.length, calendar: fx.calendar.length, docs: fx.doc_sessions.length, calls: fx.calls.length },
          day_id: row?.id ?? null,
          status: row?.status ?? null,
          billable_tenths: row?.billable_tenths ?? 0,
        };
      });
    return Response.json({ days });
  } catch (err) {
    return jsonError(err);
  }
}
