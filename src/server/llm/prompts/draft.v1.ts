import { matterCard, type FirmConfig, type Matter } from '@/lib/config';
import type { DraftOutput, DraftRequest, Profile } from '@/lib/types';
import { ACTIVITY_CODES, ACTIVITY_CODE_IDS, TASK_CODES, TASK_CODE_IDS } from '@/lib/utbms';

export const VERSION = 'draft.v1';
const hours = (t: number) => `${Math.floor(t / 10)}.${t % 10}`;

export function system(firm: FirmConfig, matter: Matter, profile: Profile): string {
  return [
    `You draft billable time entries for ${firm.attorney.display_name}, an associate at ${firm.firm.name}, from one day of her activity on one matter.`,
    '',
    'The matter:',
    matterCard(firm, matter),
    '',
    `This client's billing guidelines: one task per entry; narratives of at least ${profile.min_words} words; no entry over ${hours(profile.max_entry_tenths)} hours; block billing is ${profile.block_billing === 'block' ? 'rejected' : 'flagged'}.`,
    '',
    'Allowed task codes (UTBMS litigation):',
    ...TASK_CODES.map((c) => `${c.code} ${c.label}`),
    '',
    'Allowed activity codes:',
    ...ACTIVITY_CODES.map((c) => `${c.code} ${c.label}`),
    '',
    'How to group:',
    '- One entry is one task. Put activities in the same entry only when they are the same piece of work, such as a drafting session and the email that sends that draft, or a scheduled call and its follow-up.',
    '- Different tasks go in different entries, even on the same topic.',
    '- Every activity goes in exactly one entry or in not_billed. Use not_billed only for activities that are not billable work, and say why.',
    '',
    'How to write the narrative:',
    '- Start with a present-tense verb: Draft, Revise, Review, Analyze, Prepare, Attend, Telephone conference with, Correspond with, Confer with.',
    '- Name the specific document, person or issue. For communications, say who, for example "J. Moss (Kestrel)".',
    `- One task only, ${Math.max(8, profile.min_words)} to 35 words, no first person, no semicolons joining tasks.`,
    '- Never mention time, hours or minutes. The system computes time from the activities.',
    '- Use only names and facts that appear in the activities or the matter card. Never invent a purpose.',
    '- If the activities do not show what the work was for, write the plainest honest narrative you can and set thin to true.',
    '',
    'How to pick codes: the task code is the phase of the case the work serves. The activity code is the kind of action: A103 drafting or revising, A104 reviewing or analyzing, A101 planning and preparing, A106 communicating with the client, A107 with other outside counsel, A108 with other outside people such as experts and mediators, A105 within the firm, A109 attending a hearing, deposition or mediation.',
    '',
    'Weak and strong narratives:',
    '- Weak: "Reviewed file." Strong: "Review Calder Freight\'s document production for bill-of-lading discrepancies."',
    '- Weak: "Work on discovery." Strong: "Draft responses and objections to Calder Freight\'s First Set of Interrogatories."',
    '- Weak: "Emails with client." Strong: "Correspond with J. Moss (Kestrel) regarding custodians for document collection."',
    '- Weak: "Draft motion; call client; review production." Strong: three entries, one task each.',
    '',
    'why: one short sentence about the grouping and the codes.',
  ].join('\n');
}

export function user(req: DraftRequest, repair?: { errors: string[]; previous: DraftOutput }): string {
  const body = JSON.stringify(
    { matter_id: req.matter_id, date: req.work_date, activities: req.activities.map((a) => ({ ref: a.ref, source: a.source, start: a.start, est_minutes: a.est_minutes, text: a.text })) },
    null,
    1,
  );
  if (!repair) return body;
  return `${body}\n\nYour previous answer had these problems:\n- ${repair.errors.join('\n- ')}\n\nPrevious answer:\n${JSON.stringify(repair.previous)}\n\nReturn a corrected answer that places every activity exactly once.`;
}

export const SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['entries', 'not_billed'],
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['activity_refs', 'task_code', 'activity_code', 'narrative', 'thin', 'why'],
        properties: {
          activity_refs: { type: 'array', items: { type: 'string' } },
          task_code: { type: 'string', enum: TASK_CODE_IDS },
          activity_code: { type: 'string', enum: ACTIVITY_CODE_IDS },
          narrative: { type: 'string' },
          thin: { type: 'boolean' },
          why: { type: 'string' },
        },
      },
    },
    not_billed: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['activity_ref', 'reason'],
        properties: { activity_ref: { type: 'string' }, reason: { type: 'string' } },
      },
    },
  },
};
