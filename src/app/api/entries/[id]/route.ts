import { PatchEntryBody } from '@/lib/schemas';
import { getPool } from '@/server/db';
import { checkContext, editEntry, getEntryViews } from '@/server/entries/service';
import { getChecker } from '@/server/guidelines/index';
import { attorneyActor, jsonError, verifyRewriteToken } from '@/server/pipeline';

export const dynamic = 'force-dynamic';

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { rewrite_token, ...patch } = PatchEntryBody.parse(await req.json());
    // The client can't claim a rewrite: only a token issued for this entry, version and narrative counts.
    const rewrite = rewrite_token !== undefined && patch.narrative !== undefined && verifyRewriteToken(id, patch.version, patch.narrative, rewrite_token);
    const pool = getPool();
    await editEntry(pool, id, { ...patch, via: rewrite ? 'rewrite' : 'edit' }, attorneyActor(), checkContext(getChecker()));
    const [entry] = await getEntryViews(pool, { ids: [id] });
    return Response.json({ entry });
  } catch (err) {
    return jsonError(err);
  }
}
