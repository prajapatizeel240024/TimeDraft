import { getPool } from '@/server/db';
import { exportMatterDay } from '@/server/export/ledes';
import { attorneyActor, jsonError } from '@/server/pipeline';

export const dynamic = 'force-dynamic';

/** Downloads a LEDES 1998B invoice for one matter's approved, billable entries on one day. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const day = new URL(req.url).searchParams.get('day');
    if (!day) return Response.json({ error: 'Add ?day=<day id> to choose which day to export.' }, { status: 400 });
    const out = await exportMatterDay(getPool(), id, day, attorneyActor());
    return new Response(out.text, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${out.filename}"` } });
  } catch (err) {
    return jsonError(err);
  }
}
