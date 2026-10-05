// Picks the checker: CHECKER_IMPL=ts (default, in-process) or go (checker-go over HTTP).
import { loadEnv } from '@/lib/config';
import type { CheckInput, Flag, GuidelineChecker } from '@/lib/types';
import { goChecker } from './go-client';
import { checkEntries } from './rules';

export const tsChecker: GuidelineChecker = {
  name: 'ts@1',
  async check(input: CheckInput): Promise<Flag[]> {
    return checkEntries(input);
  },
};

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Check inputs hold narratives, so CHECKER_URL must stay on this machine, as assertLocal requires of the database. */
function checkerUrl(url: string): string {
  const host = new URL(url).hostname;
  if (!LOOPBACK.has(host)) throw new Error(`Refusing to use checker host "${host}". CHECKER_URL must be a loopback address: 127.0.0.1, localhost or ::1.`);
  return url;
}

export function getChecker(impl?: string): GuidelineChecker {
  loadEnv();
  const choice = impl ?? process.env.CHECKER_IMPL ?? 'ts';
  if (choice === 'go') return goChecker(checkerUrl(process.env.CHECKER_URL ?? 'http://127.0.0.1:8081'));
  if (choice !== 'ts') throw new Error(`CHECKER_IMPL must be "ts" or "go", not "${choice}"`);
  return tsChecker;
}
