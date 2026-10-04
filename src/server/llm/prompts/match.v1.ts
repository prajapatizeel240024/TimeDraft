import { matterCard, type FirmConfig } from '@/lib/config';
import type { MatchItem } from '@/lib/types';

export const VERSION = 'match.v1';

export function system(firm: FirmConfig): string {
  return [
    `You sort a lawyer's work activities into client matters for timekeeping at ${firm.firm.name} (${firm.firm.domain}). The attorney is ${firm.attorney.display_name} (${firm.attorney.email}).`,
    '',
    'Matters:',
    ...firm.matters.map((m) => matterCard(firm, m) + '\n'),
    `Firm administration is never billed: emails from ${firm.firm.admin_senders.join(', ')}; calls with ${firm.firm.admin_phones.join(', ')}; training, CLE, timekeeping, IT, firm meetings, business development.`,
    `Colleagues inside the firm: ${firm.firm.colleagues.map((c) => `${c.name} (${c.role}, ${c.email})`).join('; ')}. Their emails carry no client domain, so judge them by content.`,
    '',
    'For each activity, return:',
    '- matter_id: the matter it belongs to, or NONE.',
    '- category: billable (client work on a matter), admin (firm administration), personal (not work), or unknown (you cannot tell).',
    '- confidence: 0 to 1. Use 0.9 or more only when the text itself names the matter, a party, a contact, or an issue unique to one matter.',
    '- evidence: one to three short quotes copied character for character from the activity or its neighbors. Never paraphrase a quote.',
    '- why: one short sentence.',
    '',
    'Rules:',
    '- Never guess. If the text fits two matters, give your best matter with confidence below 0.6.',
    '- A contact who works on several matters belongs to whichever matter the content points to.',
    '- A phone number that belongs to one matter contact is good evidence; quote the number.',
    '- Use matter_id NONE with category admin or personal for time that is not client work.',
  ].join('\n');
}

export function user(items: MatchItem[]): string {
  return JSON.stringify(
    { activities: items.map((i) => ({ ref: i.ref, source: i.source, when: i.when, participants: i.participants, text: i.text, neighbors: i.neighbors })) },
    null,
    1,
  );
}

export function schema(firm: FirmConfig): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['matches'],
    properties: {
      matches: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['activity_ref', 'matter_id', 'category', 'confidence', 'evidence', 'why'],
          properties: {
            activity_ref: { type: 'string' },
            matter_id: { type: 'string', enum: [...firm.matters.map((m) => m.id), 'NONE'] },
            category: { type: 'string', enum: ['billable', 'admin', 'personal', 'unknown'] },
            confidence: { type: 'number' },
            evidence: { type: 'array', items: { type: 'string' } },
            why: { type: 'string' },
          },
        },
      },
    },
  };
}
