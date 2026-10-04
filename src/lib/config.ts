// Server-only: loads env files and config/firm.yaml. Never import this from a client component.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import type { Profile, Words } from './types';

const ProfileZ = z.object({
  max_entry_tenths: z.number().int().positive(),
  min_words: z.number().int().positive(),
  block_billing: z.enum(['warn', 'block']),
  comm_max_tenths: z.number().int().positive(),
  daily_max_tenths: z.number().int().positive(),
});

const WordsZ = z.object({
  task_verbs: z.array(z.string()),
  same_task_pairs: z.array(z.tuple([z.string(), z.string()])),
  vague_phrases: z.array(z.string()),
  generic_objects: z.array(z.string()),
  role_words: z.array(z.string()),
  admin: z.array(z.string()),
  personal: z.array(z.string()),
  generic_caps: z.array(z.string()),
});

const PartyZ = z.object({
  name: z.string(),
  role: z.enum(['opposing_party', 'opposing_counsel', 'client_contact', 'mediator', 'expert', 'court']),
  aliases: z.array(z.string()).default([]),
  domains: z.array(z.string()).default([]),
  email: z.string().optional(),
  phone: z.string().optional(),
});

const MatterZ = z.object({
  id: z.string().regex(/^M-\d{4}$/),
  name: z.string(),
  short_name: z.string(),
  stage: z.string(),
  profile: z.string(),
  client: z.object({
    name: z.string(),
    aliases: z.array(z.string()).default([]),
    domains: z.array(z.string()),
    ledes_client_id: z.string().max(20),
    client_matter_id: z.string().max(20),
  }),
  parties: z.array(PartyZ),
  keywords: z.array(z.string()),
  doc_folders: z.array(z.string()),
});

const FirmConfigZ = z.object({
  firm: z.object({
    name: z.string(),
    domain: z.string(),
    ledes_firm_id: z.string().max(20),
    admin_senders: z.array(z.string()),
    admin_phones: z.array(z.string()),
    colleagues: z.array(z.object({ name: z.string(), role: z.string(), email: z.string() })),
  }),
  attorney: z.object({
    id: z.string().max(8),
    name: z.string().max(30),
    display_name: z.string(),
    email: z.string(),
    classification: z.string().max(10),
    rate_cents: z.number().int().positive(),
  }),
  timezone: z.string(),
  profiles: z.record(z.string(), ProfileZ),
  matters: z.array(MatterZ).min(1),
  shared_contacts: z.array(
    z.object({
      name: z.string(),
      org: z.string(),
      email: z.string(),
      phone: z.string(),
      matters: z.array(z.string()),
      note: z.string().default(''),
    }),
  ),
  words: WordsZ,
});

export type FirmConfig = z.infer<typeof FirmConfigZ>;
export type Matter = FirmConfig['matters'][number];
export type Party = Matter['parties'][number];

let cachedFirm: FirmConfig | null = null;
let envLoaded = false;

/** Loads .env.local then .env (variables already set in the environment win). */
export function loadEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  for (const file of ['.env.local', '.env']) {
    const full = path.join(/*turbopackIgnore: true*/ process.cwd(), file);
    if (fs.existsSync(full)) process.loadEnvFile(full);
  }
}

export function loadFirm(): FirmConfig {
  if (cachedFirm) return cachedFirm;
  const raw = fs.readFileSync(path.join(/*turbopackIgnore: true*/ process.cwd(), 'config', 'firm.yaml'), 'utf8');
  const firm = FirmConfigZ.parse(YAML.parse(raw));
  for (const m of firm.matters) {
    if (!firm.profiles[m.profile]) throw new Error(`config/firm.yaml: matter ${m.id} uses unknown profile "${m.profile}"`);
  }
  for (const c of firm.shared_contacts) {
    for (const id of c.matters) {
      if (!firm.matters.some((m) => m.id === id)) throw new Error(`config/firm.yaml: ${c.name} lists unknown matter ${id}`);
    }
  }
  cachedFirm = firm;
  return firm;
}

export function matterById(firm: FirmConfig, id: string): Matter {
  const m = firm.matters.find((x) => x.id === id);
  if (!m) throw new Error(`Unknown matter ${id}`);
  return m;
}

export function profileFor(firm: FirmConfig, matterId: string): Profile {
  return firm.profiles[matterById(firm, matterId).profile];
}

export function wordsOf(firm: FirmConfig): Words {
  return firm.words;
}

/** Plain-text matter card for prompts and for the matcher's evidence checks. */
export function matterCard(firm: FirmConfig, m: Matter): string {
  const parties = m.parties
    .map((p) => {
      const bits = [p.name, `(${p.role.replace('_', ' ')})`];
      if (p.email) bits.push(p.email);
      if (p.phone) bits.push(p.phone);
      if (p.domains.length) bits.push(`domains ${p.domains.join(', ')}`);
      if (p.aliases.length) bits.push(`also called ${p.aliases.join(', ')}`);
      return bits.join(' ');
    })
    .join('; ');
  const shared = firm.shared_contacts
    .filter((c) => c.matters.includes(m.id))
    .map((c) => `${c.name} of ${c.org} (${c.email}, ${c.phone}) also works on other matters: ${c.note}`)
    .join('; ');
  return [
    `${m.id} ${m.name} (stage: ${m.stage}).`,
    `Client: ${m.client.name}${m.client.aliases.length ? ` ("${m.client.aliases.join('", "')}")` : ''}, domains ${m.client.domains.join(', ')}.`,
    `Parties and contacts: ${parties}.`,
    shared ? `Shared contact: ${shared}.` : '',
    `Keywords: ${m.keywords.join(', ')}.`,
    `Document folders: ${m.doc_folders.join(', ')}.`,
  ]
    .filter(Boolean)
    .join('\n');
}
