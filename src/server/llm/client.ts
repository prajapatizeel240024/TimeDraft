// The only code that calls the Claude API. Structured outputs via output_config.format, zod validation
// for what the API can't enforce, stop_reason handling, and a log row (and cache entry) per call.
import Anthropic from '@anthropic-ai/sdk';
import type { Pool } from 'pg';
import type { ZodType } from 'zod';
import { loadEnv, loadFirm, matterById, profileFor } from '@/lib/config';
import type { DraftOutput, DraftRequest, LLM, MatchAnswer, MatchItem, RewriteOutput, RewriteRequest } from '@/lib/types';
import { DraftOutputZ, MatchOutputZ, RewriteOutputZ } from '@/lib/schemas';
import { normalizeCode } from '@/lib/utbms';
import { cacheKey, getCached, logCall, type CallLog } from './cache';
import * as draftPrompt from './prompts/draft.v1';
import * as matchPrompt from './prompts/match.v1';
import * as rewritePrompt from './prompts/rewrite.v1';

export class RefusalError extends Error {}
export class LLMUnavailableError extends Error {}

export interface StructuredCall<T> {
  purpose: CallLog['purpose'];
  model: string;
  promptVersion: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  zod: ZodType<T>;
  maxTokens: number;
}

let client: Anthropic | null = null;

export async function callStructured<T>(db: Pool, call: StructuredCall<T>): Promise<T> {
  loadEnv();
  const key = cacheKey({ model: call.model, prompt: call.promptVersion, system: call.system, user: call.user, schema: call.schema });
  if ((process.env.LLM_CACHE ?? 'on') !== 'off') {
    const hit = await getCached(db, key);
    if (hit) return call.zod.parse(hit);
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new LLMUnavailableError('ANTHROPIC_API_KEY is not set. Add it to .env.local, or set LLM_MODE=oracle to test without Claude.');
  client ??= new Anthropic({ apiKey, maxRetries: 3 });

  let maxTokens = call.maxTokens;
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = Date.now();
    const res = await client.messages.create({
      model: call.model,
      max_tokens: maxTokens,
      // The stable part goes first with a cache breakpoint, so repeated eval calls cost less.
      system: [{ type: 'text', text: call.system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: call.user }],
      output_config: { format: { type: 'json_schema', schema: call.schema } },
    });
    const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    await logCall(db, {
      purpose: call.purpose,
      model: call.model,
      promptVersion: call.promptVersion,
      cacheKey: key,
      request: { model: call.model, max_tokens: maxTokens, system: call.system, user: call.user },
      response: parsed,
      stopReason: res.stop_reason,
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      latencyMs: Date.now() - started,
    });
    if (res.stop_reason === 'refusal') throw new RefusalError(`Claude declined the ${call.purpose} request.`);
    if (res.stop_reason === 'max_tokens' && attempt === 0) {
      maxTokens *= 2;
      continue;
    }
    if (res.stop_reason !== 'end_turn') throw new Error(`Claude stopped with "${res.stop_reason}" on the ${call.purpose} request.`);
    return call.zod.parse(parsed);
  }
  throw new Error(`Claude ran out of tokens twice on the ${call.purpose} request.`);
}

export function anthropicLLM(db: Pool): LLM {
  loadEnv();
  const firm = loadFirm();
  const models = { match: process.env.MODEL_MATCH ?? 'claude-haiku-4-5-20251001', draft: process.env.MODEL_DRAFT ?? 'claude-sonnet-5-5' };
  return {
    name: 'anthropic',
    async match(items: MatchItem[]): Promise<MatchAnswer[]> {
      if (!items.length) return [];
      const out = await callStructured(db, {
        purpose: 'match',
        model: models.match,
        promptVersion: matchPrompt.VERSION,
        system: matchPrompt.system(firm),
        user: matchPrompt.user(items),
        schema: matchPrompt.schema(firm),
        zod: MatchOutputZ,
        maxTokens: 600 + 250 * items.length,
      });
      return out.matches.map((m) => ({ ...m, matter_id: m.matter_id.toUpperCase() === 'NONE' ? 'NONE' : normalizeCode(m.matter_id) }));
    },
    async draft(req: DraftRequest, repair?: { errors: string[]; previous: DraftOutput }) {
      const matter = matterById(firm, req.matter_id);
      const out = await callStructured(db, {
        purpose: repair ? 'repair' : 'draft',
        model: models.draft,
        promptVersion: draftPrompt.VERSION,
        system: draftPrompt.system(firm, matter, profileFor(firm, matter.id)),
        user: draftPrompt.user(req, repair),
        schema: draftPrompt.SCHEMA,
        zod: DraftOutputZ,
        maxTokens: 800 + 300 * req.activities.length,
      });
      return { ...out, meta: { promptVersion: draftPrompt.VERSION, model: models.draft } };
    },
    async rewrite(req: RewriteRequest): Promise<RewriteOutput & { meta: { promptVersion: string; model: string } }> {
      const matter = matterById(firm, req.matter_id);
      const out = await callStructured(db, {
        purpose: 'rewrite',
        model: models.draft,
        promptVersion: rewritePrompt.VERSION,
        system: rewritePrompt.system(firm, matter, profileFor(firm, matter.id)),
        user: rewritePrompt.user(req),
        schema: rewritePrompt.SCHEMA,
        zod: RewriteOutputZ,
        maxTokens: 700,
      });
      return { ...out, meta: { promptVersion: rewritePrompt.VERSION, model: models.draft } };
    },
  };
}

/** LLM_MODE=anthropic (default) calls Claude. LLM_MODE=oracle answers from the eval keys, for testing only. */
export async function getLLM(db: Pool): Promise<LLM> {
  loadEnv();
  const mode = process.env.LLM_MODE ?? 'anthropic';
  if (mode === 'oracle') {
    const { oracleLLM } = await import('../../../evals/score');
    return oracleLLM();
  }
  if (mode !== 'anthropic') throw new Error(`LLM_MODE must be "anthropic" or "oracle", not "${mode}"`);
  return anthropicLLM(db);
}
