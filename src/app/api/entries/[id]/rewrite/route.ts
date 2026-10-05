import { RewriteBody } from '@/lib/schemas';
import { getPool } from '@/server/db';
import { getLLM } from '@/server/llm/client';
import { jsonError, suggestRewrite } from '@/server/pipeline';

export const dynamic = 'force-dynamic';

/** Returns a suggestion and its rewrite_token only. Saving it is a PATCH that carries the token, which the PATCH route verifies before the audit row credits Claude. */
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
