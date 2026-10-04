import { getPool } from '@/server/db';
import { getDayView } from '@/server/entries/service';
import { getChecker } from '@/server/guidelines/index';
import { jsonError } from '@/server/pipeline';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return Response.json(await getDayView(getPool(), id, getChecker()));
  } catch (err) {
    return jsonError(err);
  }
}
