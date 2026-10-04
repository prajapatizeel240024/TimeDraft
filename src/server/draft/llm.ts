// Prepares one matter-day for Claude, validates the answer, and makes one repair call if needed.
import type { Activity, DraftActivity, LLM, LLMCallMeta } from '@/lib/types';
import { localTime } from '@/server/match/llm';
import { validateDraft, type Validation } from './validate';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function toDraftActivities(activities: Activity[]): DraftActivity[] {
  return activities.map((a, i) => ({
    ref: `d${i + 1}`,
    activity_id: a.id,
    external_id: a.external_id,
    source: a.source,
    start: localTime(a.started_at),
    est_minutes: Math.round((a.est_seconds / 60) * 10) / 10,
    text: clip(a.body, 650),
  }));
}

export async function draftMatter(llm: LLM, matterId: string, workDate: string, activities: Activity[]): Promise<{ request: DraftActivity[]; result: Validation; meta: LLMCallMeta; repaired: boolean }> {
  const request = toDraftActivities(activities);
  const req = { matter_id: matterId, work_date: workDate, activities: request };
  const first = await llm.draft(req);
  let result = validateDraft(first, request);
  let meta = first.meta;
  let repaired = false;
  if (result.errors.length) {
    const second = await llm.draft(req, { errors: result.errors, previous: { entries: first.entries, not_billed: first.not_billed } });
    result = validateDraft(second, request);
    meta = second.meta;
    repaired = true;
  }
  return { request, result, meta, repaired };
}
