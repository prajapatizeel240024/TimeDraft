import { RewriteBody } from '@/lib/schemas';
import { getPool } from '@/server/db';
import { getLLM } from '@/server/llm/client';
import { jsonError, suggestRewrite } from '@/server/pipeline';

export const dynamic = 'force-dynamic';

/** Returns a suggestion only. Saving it is a PATCH with via: "rewrite", so the audit log shows who accepted it. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { hint } = RewriteBody.parse(await req.json().catch(() => ({})));
    const pool = getPool();
    return Response.json(await suggestRewrite(pool, id, hint, await getLLM(pool)));
  } catch (err) {
    return jsonError(err);
  }
}
