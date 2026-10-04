import { PatchEntryBody } from '@/lib/schemas';
import { getPool } from '@/server/db';
import { checkContext, editEntry, getEntryViews } from '@/server/entries/service';
import { getChecker } from '@/server/guidelines/index';
import { attorneyActor, jsonError } from '@/server/pipeline';

export const dynamic = 'force-dynamic';

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = PatchEntryBody.parse(await req.json());
    const pool = getPool();
    await editEntry(pool, id, body, attorneyActor(), checkContext(getChecker()));
    const [entry] = await getEntryViews(pool, { ids: [id] });
    return Response.json({ entry });
  } catch (err) {
    return jsonError(err);
  }
}
