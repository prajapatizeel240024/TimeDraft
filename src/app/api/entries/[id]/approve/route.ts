import { ApproveBody } from '@/lib/schemas';
import { getPool } from '@/server/db';
import { approveEntry, getEntryViews } from '@/server/entries/service';
import { attorneyActor, jsonError } from '@/server/pipeline';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = ApproveBody.parse(await req.json());
    const pool = getPool();
    await approveEntry(pool, id, body, attorneyActor());
    const [entry] = await getEntryViews(pool, { ids: [id] });
    return Response.json({ entry });
  } catch (err) {
    return jsonError(err);
  }
}
