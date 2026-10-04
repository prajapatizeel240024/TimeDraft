import { getPool } from '@/server/db';
import { getEntrySources } from '@/server/entries/service';
import { jsonError } from '@/server/pipeline';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return Response.json({ sources: await getEntrySources(getPool(), id) });
  } catch (err) {
    return jsonError(err);
  }
}
