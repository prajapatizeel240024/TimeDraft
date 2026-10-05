import { LedesExportBody } from '@/lib/schemas';
import { getPool } from '@/server/db';
import { exportMatterDay } from '@/server/export/ledes';
import { attorneyActor, jsonError } from '@/server/pipeline';

export const dynamic = 'force-dynamic';

/** Exports a LEDES 1998B invoice for one matter's approved, billable entries on one day. Only POST: every export takes a new invoice number and writes an audit row, so GET answers 405. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { day_id } = LedesExportBody.parse(await req.json());
    const out = await exportMatterDay(getPool(), id, day_id, attorneyActor());
    return new Response(out.text, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${out.filename}"` } });
  } catch (err) {
    return jsonError(err);
  }
}
