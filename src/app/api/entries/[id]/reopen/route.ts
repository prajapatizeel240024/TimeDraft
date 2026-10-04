import { ReopenBody } from '@/lib/schemas';
import { getPool } from '@/server/db';
import { checkContext, getEntryViews, reopenEntry } from '@/server/entries/service';
import { getChecker } from '@/server/guidelines/index';
import { attorneyActor, jsonError } from '@/server/pipeline';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = ReopenBody.parse(await req.json());
    const pool = getPool();
    await reopenEntry(pool, id, body, attorneyActor(), checkContext(getChecker()));
    const [entry] = await getEntryViews(pool, { ids: [id] });
    return Response.json({ entry });
  } catch (err) {
    return jsonError(err);
  }
}
