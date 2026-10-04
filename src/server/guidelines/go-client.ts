// The Go checker behind the same GuidelineChecker interface. No silent fallback: if the service is down,
// callers get a clear error instead of quietly switching to the TypeScript rules.
import type { CheckInput, Flag, GuidelineChecker } from '@/lib/types';

export function goChecker(baseUrl: string): GuidelineChecker {
  return {
    name: 'go@1',
    async check(input: CheckInput): Promise<Flag[]> {
      let res: Response;
      try {
        res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/check`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(2000),
        });
      } catch (err) {
        throw new Error(`The Go checker at ${baseUrl} isn't reachable (${err instanceof Error ? err.message : String(err)}). Start it, or set CHECKER_IMPL=ts.`);
      }
      if (!res.ok) throw new Error(`The Go checker answered ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as { flags: Flag[]; checker: string };
      return body.flags;
    },
  };
}
