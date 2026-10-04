import { ResolveBody } from '@/lib/schemas';
import { getPool } from '@/server/db';
import { attorneyActor, defaultDeps, jsonError, resolveAndDraft } from '@/server/pipeline';

export const dynamic = 'force-dynamic';

/** The attorney places a queued activity on a matter, or marks it admin, personal or not work. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = ResolveBody.parse(await req.json());
    const pool = getPool();
    const entries = await resolveAndDraft(pool, id, body, attorneyActor(), await defaultDeps(pool));
    return Response.json({ entries });
  } catch (err) {
    return jsonError(err);
  }
}
