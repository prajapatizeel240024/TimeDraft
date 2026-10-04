// Shared types. This file has no runtime imports, so client components can use it too.

export type Source = 'email' | 'calendar' | 'doc' | 'call';
export type Category = 'billable' | 'admin' | 'personal' | 'unknown';
export type MatchMethod = 'rule' | 'llm' | 'attorney';
export type MatchStatus = 'auto' | 'needs_review' | 'resolved' | 'ignored';
export type DurationBasis = 'exact' | 'scheduled' | 'measured' | 'estimated' | 'none';
export type EntryStatus = 'draft' | 'approved' | 'rejected';

export interface Profile {
  max_entry_tenths: number;
  min_words: number;
  block_billing: 'warn' | 'block';
  comm_max_tenths: number;
  daily_max_tenths: number;
}

export interface Words {
  task_verbs: string[];
  same_task_pairs: [string, string][];
  vague_phrases: string[];
  generic_objects: string[];
  role_words: string[];
  admin: string[];
  personal: string[];
  generic_caps: string[];
}

export interface Activity {
  id: string;
  day_id: string;
  source: Source;
  external_id: string;
  started_at: string;
  ended_at: string | null;
  est_seconds: number;
  duration_basis: DurationBasis;
  participants: string[];
  body: string;
  meta: Record<string, unknown>;
  merged_into: string | null;
}

export interface Interval {
  start: string;
  end: string;
}

export interface CheckEntry {
  id: string;
  profile: string; // key into CheckInput.profiles, so one day can mix strict and default clients
  units_tenths: number;
  task_code: string;
  activity_code: string;
  narrative: string;
  thin_context: boolean;
  billable: boolean;
  source_categories: Category[];
  intervals: Interval[]; // calls, meetings and doc sessions only; emails have no reliable span
}

export type FlagCode =
  | 'BLOCK_BILLING'
  | 'VAGUE_NARRATIVE'
  | 'LONG_ENTRY'
  | 'NON_BILLABLE_ADMIN'
  | 'OVERLAP'
  | 'DAILY_TOTAL'
  | 'UNGROUNDED_TERM';

export interface Flag {
  entry_id: string | null; // null for day-level flags
  code: FlagCode;
  severity: 'block' | 'warn';
  message: string;
  evidence: string[];
}

export interface CheckInput {
  profiles: Record<string, Profile>;
  words: Words;
  daily_max_tenths: number;
  entries: CheckEntry[];
}

export interface GuidelineChecker {
  name: string; // 'ts@1' or 'go@1'
  check(input: CheckInput): Promise<Flag[]>;
}

// ---------- Claude-facing shapes ----------

export interface MatchItem {
  ref: string;
  activity_id: string;
  external_id: string;
  source: Source;
  when: string;
  participants: string[];
  text: string;
  neighbors: { source: Source; when: string; text: string }[];
}

export interface MatchAnswer {
  activity_ref: string;
  matter_id: string; // a matter id or 'NONE'
  category: Category;
  confidence: number;
  evidence: string[];
  why: string;
}

export interface DraftActivity {
  ref: string;
  activity_id: string;
  external_id: string;
  source: Source;
  start: string; // local time label, e.g. "09:15"
  est_minutes: number;
  text: string;
}

export interface DraftRequest {
  matter_id: string;
  work_date: string;
  activities: DraftActivity[];
}

export interface DraftEntryOut {
  activity_refs: string[];
  task_code: string;
  activity_code: string;
  narrative: string;
  thin: boolean;
  why: string;
}

export interface DraftOutput {
  entries: DraftEntryOut[];
  not_billed: { activity_ref: string; reason: string }[];
}

export interface RewriteRequest {
  matter_id: string;
  narrative: string;
  task_code: string;
  activity_code: string;
  flags: string[];
  sources: { ref: string; external_id: string; source: Source; when: string; text: string }[];
  hint: string;
}

export interface RewriteOutput {
  status: 'rewritten' | 'needs_detail';
  narrative: string;
  question: string;
  facts_used: { activity_ref: string; fact: string }[];
}

export interface LLMCallMeta {
  promptVersion: string;
  model: string;
}

export interface LLM {
  name: string; // 'anthropic' or 'oracle'
  match(items: MatchItem[]): Promise<MatchAnswer[]>;
  draft(req: DraftRequest, repair?: { errors: string[]; previous: DraftOutput }): Promise<DraftOutput & { meta: LLMCallMeta }>;
  rewrite(req: RewriteRequest): Promise<RewriteOutput & { meta: LLMCallMeta }>;
}
