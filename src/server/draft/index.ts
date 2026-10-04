// Drafts entries for every matter with matched, not-yet-drafted billable activities (in parallel),
// then recomputes the day's flags once.
import type { Pool } from 'pg';
import { matterById, matterCard, type FirmConfig } from '@/lib/config';
import type { Activity, GuidelineChecker, LLM } from '@/lib/types';
import { withTx } from '@/server/db';
import { createDraftEntry, recomputeDayFlags } from '@/server/entries/service';
import { loadActivitiesById } from '@/server/ingest/normalize';
import { draftMatter } from './llm';
import { ungroundedTerms } from './validate';

export interface DraftSummary {
  entryIds: string[];
  notBilled: number;
  unplaced: number;
  repairs: number;
}

export async function draftDay(pool: Pool, dayId: string, firm: FirmConfig, llm: LLM, checker: GuidelineChecker, onMatterDone?: (matterId: string, entryIds: string[]) => Promise<void> | void): Promise<DraftSummary> {
  const day = await pool.query<{ work_date: string }>('select work_date from days where id = $1', [dayId]);
  if (!day.rowCount) throw new Error(`Unknown day ${dayId}`);
  const workDate = day.rows[0].work_date;
  const pending = await pool.query<{ activity_id: string; matter_id: string }>(
    `select am.activity_id, am.matter_id from activity_matches am join activities a on a.id = am.activity_id
      where a.day_id = $1 and am.category = 'billable' and am.matter_id is not null and am.status in ('auto','resolved')
        and not exists (select 1 from entry_sources es where es.activity_id = am.activity_id)`,
    [dayId],
  );
  const byMatter = new Map<string, string[]>();
  for (const r of pending.rows) byMatter.set(r.matter_id, [...(byMatter.get(r.matter_id) ?? []), r.activity_id]);
  const summary: DraftSummary = { entryIds: [], notBilled: 0, unplaced: 0, repairs: 0 };

  await Promise.all(
    [...byMatter.entries()].map(async ([matterId, ids]) => {
      const activities = await loadActivitiesById(pool, ids);
      const { request, result, meta, repaired } = await draftMatter(llm, matterId, workDate, activities);
      if (repaired) summary.repairs += 1;
      const byRef = new Map(request.map((r) => [r.ref, r]));
      const actById = new Map<string, Activity>(activities.map((a) => [a.id, a]));
      // Grounding context: the matter card plus the people inside the firm, who never appear in a matter card.
      const matterText = [matterCard(firm, matterById(firm, matterId)), firm.attorney.display_name, ...firm.firm.colleagues.map((c) => c.name)].join('\n');
      const created = await withTx(pool, async (c) => {
        const out: string[] = [];
        for (const e of result.entries) {
          const sources = e.refs.map((r) => actById.get(byRef.get(r)!.activity_id)!);
          if (!sources.some((s) => s.est_seconds > 0)) continue;
          out.push(
            await createDraftEntry(c, {
              dayId,
              matterId,
              workDate,
              sources: sources.map((s) => ({ id: s.id, source: s.source, started_at: s.started_at, est_seconds: s.est_seconds })),
              taskCode: e.task_code,
              activityCode: e.activity_code,
              narrative: e.narrative,
              thin: e.thin,
              why: e.why,
              promptVersion: meta.promptVersion,
              actor: `${llm.name}:${meta.promptVersion}`,
              ungrounded: ungroundedTerms(e.narrative, sources.map((s) => `${s.body}\n${s.participants.join(' ')}`), matterText, firm.words),
            }),
          );
        }
        for (const nb of result.notBilled) {
          await c.query(`update activity_matches set status = 'ignored', evidence = evidence || $2::jsonb, updated_at = now() where activity_id = $1`, [byRef.get(nb.ref)!.activity_id, JSON.stringify([{ signal: 'not_billed', value: nb.reason }])]);
        }
        for (const ref of result.unplaced) {
          await c.query(`update activity_matches set status = 'needs_review', evidence = evidence || $2::jsonb, updated_at = now() where activity_id = $1`, [byRef.get(ref)!.activity_id, JSON.stringify([{ signal: 'drafter_unplaced', value: 'The drafter could not place this activity.' }])]);
        }
        return out;
      });
      summary.notBilled += result.notBilled.length;
      summary.unplaced += result.unplaced.length;
      summary.entryIds.push(...created);
      await onMatterDone?.(matterId, created);
    }),
  );

  await withTx(pool, async (c) => {
    await recomputeDayFlags(c, dayId, { checker, words: firm.words });
    await c.query(`update days set status = 'drafted' where id = $1`, [dayId]);
  });
  return summary;
}
