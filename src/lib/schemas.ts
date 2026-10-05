// zod schemas for fixtures, answer keys, Claude outputs and API bodies.
// Structured outputs guarantee shape; these enforce what the API can't (ranges, lengths, ids).
import { z } from 'zod';

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/, 'ISO time with offset');
const isoOrEmpty = z.union([iso, z.literal('')]);

export const DayFixtureSchema = z.object({
  day_id: z.string().regex(/^day-\d{2}$/),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  emails: z.array(
    z.object({
      id: z.string(),
      thread_id: z.string(),
      direction: z.enum(['sent', 'received']),
      from: z.string(),
      to: z.array(z.string()),
      cc: z.array(z.string()),
      subject: z.string(),
      body: z.string(),
      at: iso,
      opened_at: isoOrEmpty,
      attachments: z.array(z.string()),
    }),
  ),
  calendar: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      start: iso,
      end: iso,
      attendees: z.array(z.string()),
      response: z.enum(['accepted', 'declined', 'tentative']),
      description: z.string(),
    }),
  ),
  doc_sessions: z.array(
    z.object({
      id: z.string(),
      path: z.string(),
      title: z.string(),
      start: iso,
      end: iso,
      active_seconds: z.number().int().nonnegative(),
    }),
  ),
  calls: z.array(
    z.object({
      id: z.string(),
      direction: z.enum(['in', 'out']),
      number: z.string(),
      start: iso,
      duration_seconds: z.number().int().positive(),
    }),
  ),
});
export type DayFixture = z.infer<typeof DayFixtureSchema>;

export const TrapKinds = [
  'duplicate_call',
  'shared_expert',
  'internal_email',
  'phone_only',
  'admin',
  'personal',
  'declined',
  'long_block',
  'thin_context',
] as const;

export const AnswerKeySchema = z.object({
  day_id: z.string(),
  split: z.enum(['dev', 'holdout']),
  blocks: z.array(
    z.object({
      id: z.string(),
      matter_id: z.string().nullable(),
      category: z.enum(['billable', 'admin', 'personal']),
      task_code: z.string(), // "" when not billable
      activity_code: z.string(),
      true_seconds: z.number().int().positive(),
      signal: z.enum(['strong', 'weak', 'none']),
      summary: z.string(), // the narrative a careful attorney would write
      thin: z.boolean(), // true when the artifacts alone don't show the purpose
      draft_narrative: z.string(), // what an honest drafter can write from the artifacts alone
    }),
  ),
  activities: z.record(z.string(), z.object({ block_id: z.string().nullable() })), // null = not work (declined, unread)
  traps: z.array(z.object({ kind: z.enum(TrapKinds), activity_ids: z.array(z.string()), expect: z.string() })),
});
export type AnswerKey = z.infer<typeof AnswerKeySchema>;

// ---------- Claude outputs ----------

export const MatchOutputZ = z.object({
  matches: z.array(
    z.object({
      activity_ref: z.string(),
      matter_id: z.string(),
      category: z.enum(['billable', 'admin', 'personal', 'unknown']),
      confidence: z.number().min(0).max(1),
      evidence: z.array(z.string()).max(5),
      why: z.string(),
    }),
  ),
});

export const DraftOutputZ = z.object({
  entries: z.array(
    z.object({
      activity_refs: z.array(z.string()).min(1),
      task_code: z.string(),
      activity_code: z.string(),
      narrative: z.string().min(1).max(400),
      thin: z.boolean(),
      why: z.string(),
    }),
  ),
  not_billed: z.array(z.object({ activity_ref: z.string(), reason: z.string() })),
});

export const RewriteOutputZ = z.object({
  status: z.enum(['rewritten', 'needs_detail']),
  narrative: z.string().max(400),
  question: z.string().max(300),
  facts_used: z.array(z.object({ activity_ref: z.string(), fact: z.string() })),
});

// ---------- API bodies ----------

export const LoadDayBody = z.object({ fixture_id: z.string().regex(/^day-\d{2}$/) });
export const ResolveBody = z.union([
  z.object({ matter_id: z.string().regex(/^M-\d{4}$/) }),
  z.object({ category: z.enum(['admin', 'personal', 'ignore']) }),
]);
export const PatchEntryBody = z.object({
  version: z.number().int().positive(),
  units_tenths: z.number().int().min(1).max(240).optional(),
  task_code: z.string().optional(),
  activity_code: z.string().optional(),
  narrative: z.string().trim().min(1).max(400).optional(),
  billable: z.boolean().optional(),
  rewrite_token: z.string().regex(/^[0-9a-f]{64}$/i, '64 hex characters').optional(),
});
export const ApproveBody = z.object({ version: z.number().int().positive(), override_reason: z.string().trim().max(300).optional() });
export const RejectBody = z.object({ version: z.number().int().positive(), reason: z.string().trim().min(1).max(300) });
export const ReopenBody = z.object({ version: z.number().int().positive() });
export const RewriteBody = z.object({ hint: z.string().trim().max(300).default('') });
export const LedesExportBody = z.object({ day_id: z.uuid() });
