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

export function getChecker(impl?: string): GuidelineChecker {
  loadEnv();
  const choice = impl ?? process.env.CHECKER_IMPL ?? 'ts';
  if (choice === 'go') return goChecker(process.env.CHECKER_URL ?? 'http://localhost:8081');
  if (choice !== 'ts') throw new Error(`CHECKER_IMPL must be "ts" or "go", not "${choice}"`);
  return tsChecker;
}
