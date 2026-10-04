import { getPool } from '@/server/db';
import { defaultDeps, runDay, type PipelineEvent } from '@/server/pipeline';

export const dynamic = 'force-dynamic';

const running = new Set<string>();

/** Runs the pipeline for a day and streams its progress as server-sent events. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pool = getPool();
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: PipelineEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      if (running.has(id)) {
        send({ type: 'error', message: 'This day is already being drafted. Wait for that run to finish.' });
        controller.close();
        return;
      }
      running.add(id);
      try {
        const deps = await defaultDeps(pool);
        await runDay(pool, id, send, deps);
      } catch (err) {
        // runDay reports its own errors as events; this catches setup errors such as a bad LLM_MODE.
        if (err instanceof Error && !err.message.includes('ANTHROPIC_API_KEY')) console.error(err);
      } finally {
        running.delete(id);
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' } });
}
