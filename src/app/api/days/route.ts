import fs from 'node:fs';
import path from 'node:path';
import { loadFirm } from '@/lib/config';
import { DayFixtureSchema, LoadDayBody } from '@/lib/schemas';
import { getPool } from '@/server/db';
import { ingestFixture } from '@/server/ingest/normalize';
import { jsonError } from '@/server/pipeline';

export const dynamic = 'force-dynamic';

/** Loads a synthetic day. Loading the same day twice returns the existing one. */
export async function POST(req: Request) {
  try {
    const { fixture_id } = LoadDayBody.parse(await req.json());
    const file = path.join(process.cwd(), 'evals', 'days', `${fixture_id}.json`);
    if (!fs.existsSync(file)) return Response.json({ error: `There is no synthetic day called ${fixture_id}.` }, { status: 404 });
    const fx = DayFixtureSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    const { dayId, created } = await ingestFixture(getPool(), fx, loadFirm().attorney.id);
    return Response.json({ day_id: dayId, created }, { status: created ? 201 : 200 });
  } catch (err) {
    return jsonError(err);
  }
}
