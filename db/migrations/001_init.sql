-- TimeDraft schema. Entries and their history are the core; audit_events refuses
-- UPDATE and DELETE at the database level, not by convention.

create table attorneys (
  id             text primary key,                -- 'DW'
  name           text not null,                   -- 'Whitfield, Dana'
  email          text not null unique,
  classification text not null,                   -- LEDES: PT, AS, OC, LA, OT
  rate_cents     integer not null check (rate_cents > 0)
);

create table matters (
  id               text primary key,              -- 'M-1001'
  name             text not null,
  client_name      text not null,
  ledes_client_id  text not null,
  client_matter_id text not null,
  stage            text not null,
  profile          jsonb not null,                -- resolved guideline profile
  card             jsonb not null                 -- parties, domains, phones, keywords, folders
);

create table utbms_codes (
  code  text primary key,                         -- 'L120', 'A103'
  kind  text not null check (kind in ('task', 'activity')),
  phase text,                                     -- 'L100' for L120; null for A-codes
  label text not null
);

create table days (
  id          uuid primary key default gen_random_uuid(),
  fixture_id  text not null unique,               -- 'day-03'
  attorney_id text not null references attorneys(id),
  work_date   date not null,
  status      text not null default 'ingested'
              check (status in ('ingested','reconciled','matched','drafted','failed')),
  created_at  timestamptz not null default now()
);

create table activities (
  id             uuid primary key default gen_random_uuid(),
  day_id         uuid not null references days(id),
  source         text not null check (source in ('email','calendar','doc','call')),
  external_id    text not null,
  started_at     timestamptz not null,
  ended_at       timestamptz,
  est_seconds    integer not null check (est_seconds >= 0),
  duration_basis text not null
                 check (duration_basis in ('exact','scheduled','measured','estimated','none')),
  participants   text[] not null default '{}',
  body           text not null,                   -- subject + body, or title + description
  meta           jsonb not null default '{}',     -- thread_id, path, direction, number
  merged_into    uuid references activities(id),
  unique (day_id, source, external_id)
);

create table activity_matches (
  activity_id uuid primary key references activities(id),
  matter_id   text references matters(id),
  category    text not null check (category in ('billable','admin','personal','unknown')),
  method      text not null check (method in ('rule','llm','attorney')),
  confidence  numeric(4,3),
  evidence    jsonb not null default '[]',        -- rule signals or Claude's quotes
  suggestion  jsonb,                              -- Claude's answer, kept even when queued
  status      text not null check (status in ('auto','needs_review','resolved','ignored')),
  updated_at  timestamptz not null default now()
);

create table time_entries (
  id             uuid primary key default gen_random_uuid(),
  day_id         uuid not null references days(id),
  matter_id      text not null references matters(id),
  work_date      date not null,
  units_tenths   smallint not null check (units_tenths between 1 and 240),
  raw_seconds    integer not null check (raw_seconds >= 0),
  task_code      text not null references utbms_codes(code),
  activity_code  text not null references utbms_codes(code),
  narrative      text not null,
  thin_context   boolean not null default false,  -- drafter said the sources lack a purpose
  billable       boolean not null default true,
  status         text not null default 'draft' check (status in ('draft','approved','rejected')),
  origin         text not null check (origin in ('drafter','attorney')),
  why            text not null default '',        -- drafter's one-sentence explanation
  prompt_version text,
  version        integer not null default 1,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table entry_sources (                      -- provenance: powers "Why this entry"
  entry_id    uuid not null references time_entries(id),
  activity_id uuid not null references activities(id),
  seconds     integer not null,
  primary key (entry_id, activity_id)
);
create unique index entry_sources_one_entry_per_activity on entry_sources (activity_id);

create table entry_flags (                        -- current flags; history is in audit
  id              bigserial primary key,
  entry_id        uuid not null references time_entries(id),
  code            text not null,                  -- BLOCK_BILLING, VAGUE_NARRATIVE, ...
  severity        text not null check (severity in ('block','warn')),
  message         text not null,
  evidence        jsonb not null default '[]',
  checker         text not null,                  -- 'ts@1' or 'go@1'
  override_reason text
);

create table audit_events (
  id           bigserial primary key,
  subject_type text not null check (subject_type in ('entry','activity','day','export')),
  subject_id   text not null,
  version      integer,
  actor        text not null,                     -- 'system', 'claude:draft.v1', 'attorney:DW'
  action       text not null,                     -- created, edited, rewritten, approved, rejected,
                                                  -- reopened, matched, resolved, exported
  before       jsonb,
  after        jsonb,
  reason       text,
  created_at   timestamptz not null default now()
);

create function audit_events_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_events is append-only';
end;
$$;

create trigger audit_events_no_change
  before update or delete on audit_events
  for each row execute function audit_events_append_only();

create table llm_calls (                          -- every Claude call; doubles as the response cache
  id             bigserial primary key,
  purpose        text not null check (purpose in ('match','draft','repair','rewrite','render')),
  model          text not null,
  prompt_version text not null,
  cache_key      text not null,                   -- sha256(model, prompt_version, request)
  request        jsonb not null,
  response       jsonb,
  stop_reason    text,
  input_tokens   integer,
  output_tokens  integer,
  latency_ms     integer,
  created_at     timestamptz not null default now()
);

create table exports (
  id             uuid primary key default gen_random_uuid(),
  matter_id      text not null references matters(id),
  invoice_number text not null unique,
  period_start   date not null,
  period_end     date not null,
  entry_ids      uuid[] not null,
  total_cents    bigint not null,
  file_text      text not null,
  created_at     timestamptz not null default now()
);

create index on activities (day_id);
create index on activity_matches (status);
create index on time_entries (day_id, matter_id);
create index on audit_events (subject_type, subject_id, id);
create index on llm_calls (cache_key);
