import { matterCard, type FirmConfig, type Matter } from '@/lib/config';
import type { Profile, RewriteRequest } from '@/lib/types';

export const VERSION = 'rewrite.v1';

export function system(firm: FirmConfig, matter: Matter, profile: Profile): string {
  return [
    `You rewrite one time-entry narrative for ${firm.attorney.display_name} at ${firm.firm.name} so it meets the client's billing guidelines.`,
    '',
    'The matter:',
    matterCard(firm, matter),
    '',
    'Use only facts from the source activities, the matter card and the attorney\'s hint. Never invent a purpose, a document or a person.',
    '',
    'If those facts don\'t say what the work was for, return status "needs_detail", an empty narrative, and one short question for the attorney, such as "What were these notes for?".',
    `Otherwise return status "rewritten" and a narrative of ${Math.max(8, profile.min_words)} to 35 words that starts with a present-tense verb, describes one task, names the specific document, person or issue, and never mentions time. Leave question empty.`,
    'facts_used lists each fact you relied on with where it came from: an activity ref, "hint" for the attorney\'s hint, or "matter" for the matter card.',
  ].join('\n');
}

export function user(req: RewriteRequest): string {
  return JSON.stringify(
    { current_narrative: req.narrative, task_code: req.task_code, activity_code: req.activity_code, problems: req.flags, sources: req.sources.map((s) => ({ ref: s.ref, source: s.source, when: s.when, text: s.text })), attorney_hint: req.hint },
    null,
    1,
  );
}

export const SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'narrative', 'question', 'facts_used'],
  properties: {
    status: { type: 'string', enum: ['rewritten', 'needs_detail'] },
    narrative: { type: 'string' },
    question: { type: 'string' },
    facts_used: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['activity_ref', 'fact'],
        properties: { activity_ref: { type: 'string' }, fact: { type: 'string' } },
      },
    },
  },
};
