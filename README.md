# TimeDraft

An AI timekeeper for one attorney's day. TimeDraft reads a day of emails, calendar events, document edits and calls, matches each one to a client matter, and drafts billable time entries in 0.1-hour units with UTBMS codes and specific narratives. It checks every entry against the client's billing guidelines, and the attorney approves, edits or rejects each one on a review screen. Every change is logged, approved time exports as LEDES 1998B, and 12 synthetic days with answer keys measure how well it works.

Synthetic data only. Every name, `.example` domain and 555-01xx phone number is fictional.

## Run it

You need Node 20.12 or newer and Postgres 16: Docker is the easy way, or see below for a local install. Go 1.22 or newer is optional, for the Go checker.

```bash
cp .env.example .env.local        # then add your ANTHROPIC_API_KEY
npm install
npm run db:up                     # Postgres 16 in Docker, on 127.0.0.1:5432
npm run db:migrate && npm run db:seed
npm run dev                       # http://127.0.0.1:3000
```

No Docker? Any local Postgres 16 on 127.0.0.1:5432 works. Create the role once. Then `npm run db:migrate` creates `time_draft_dev`, and `npm run db:migrate -- --eval` (or the first `npm test`) creates `time_draft_eval`:

```bash
psql -h 127.0.0.1 -d postgres -c "create role timedraft login password 'timedraft' createdb"
```

Pick a day and TimeDraft drafts it while you watch. Day 03 (Tuesday, March 10, 2026) is the demo day: it has a duplicate call, a shared expert, a CLE webinar and a thin document session.

No API key yet? Set `LLM_MODE=oracle` in `.env.local` to use the answer-key stand-in. It answers from the eval keys, so it's for testing the plumbing and the screen, never for results. The page footer says when any draft on the page came from it.

Every service binds to 127.0.0.1: the app on port 3000, Postgres on 5432 and the Go checker on 8081, so nothing is reachable from another machine, and nothing is deployed or published. TimeDraft's own code makes one outside call, to the Claude API, and only when `LLM_MODE=anthropic`; `LLM_MODE=oracle` makes none. Next.js makes two calls of its own: anonymous telemetry, which `npx next telemetry disable` or `NEXT_TELEMETRY_DISABLED=1` turns off, and, under `npm run dev` only, a check against registry.npmjs.org for a newer Next.js, which those settings don't stop.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | The review screen at http://127.0.0.1:3000 |
| `npm run day:load -- day-03` | Drafts one day from the command line (add `--llm oracle` to skip Claude) |
| `npm run test` | 128 tests, including the shared guideline fixtures and the database-backed entries service |
| `npm run typecheck` | TypeScript, strict |
| `npm run eval -- --split dev` | Scores the 8 dev days and writes `evals/reports/<time>-dev-<llm>.md` |
| `npm run eval -- --split holdout` | The 4 holdout days, with real Claude only. Run it once, at the end |
| `npm run db:reset` | Empties the app tables but keeps Claude's cached answers (`-- --all` clears those too) |
| `npm run fixtures` | Regenerates the 12 synthetic days from seed 42 |
| `cd checker-go && go test ./...` | The Go checker against the same fixtures |

Eval flags: `--threshold 0.8`, `--checker ts|go`, `--llm anthropic|oracle`, `--no-cache`. The oracle answers from the keys, so it never runs on a holdout day: `npm run eval` refuses `--split holdout` or `all`, and drafting refuses days 09 to 12.

## How it works

```text
day fixture -> ingest + estimate -> reconcile -> match (rules, then Claude) -> draft (Claude) -> time math -> guideline checks -> review -> LEDES
                                                       |
                                              below the bar: review queue
```

- **Claude judges, code counts.** Claude places activities the rules can't, groups them, picks codes and writes narratives. Durations, rounding, totals, checks and exports are plain code, and Claude's output never contains a duration.
- **Don't guess, queue it.** Claude's match is accepted only if it's confident, every quote it gives really appears in the activity, and no rule points elsewhere. Anything else waits for the attorney.
- **Round once per entry, in integers.** Billed time is `ceil(seconds / 360)` tenths, stored as an integer.
- **History can't be rewritten.** A database trigger rejects UPDATE and DELETE on `audit_events`. A save is credited to Claude only when it carries the token signed for Claude's suggestion and changes nothing but the narrative (set `REWRITE_SIGNING_KEY`, or each server process makes its own random key), and Export LEDES is a POST, because every export takes a new invoice number.
- **Answer keys by construction.** Each synthetic day is planned first and rendered second, so the key never depends on the generated text.
- **Honest drafts.** When the sources don't say what work was for, the drafter marks the entry thin instead of inventing a purpose. The checker flags it, and Rewrite asks the attorney.

## The Go checker

`checker-go` is a stdlib-only service with the same rounding and guideline rules as `src/server/guidelines/rules.ts`. Both pass `contracts/fixtures/guidelines.json`, and on the dev days they produce identical flags.

```bash
cd checker-go && go run ./cmd/checker          # or: docker compose --profile go up -d checker
CHECKER_IMPL=go npm run dev                    # the footer shows "go@1"
```

## Two-minute demo

| Time | On screen |
| --- | --- |
| 0:00 | Day 03 on the home page: 16 activities |
| 0:12 | Draft this day: stages tick by, entries stream in under three matters with hours, codes and narratives |
| 0:40 | Lena Park works on two matters. If she's under "Needs a matter", pick Halberd and a new entry appears. If Claude placed her, open "Why this entry" to show the quote it used |
| 0:58 | The Notes.docx entry is flagged vague. Rewrite: Claude asks what the notes were for. Answer "Calder 30(b)(6) depo outline" and the flag clears |
| 1:25 | Why this entry, then History with the before and after |
| 1:40 | Approve, then Export LEDES and open the file |
| 1:55 | The holdout eval headline, and "checks run in Go" |

Before recording, do one warm-up run so the structured-output grammars compile and Claude's answers are cached. Then `npm run db:reset` and record. Be ready to run it live with `LLM_CACHE=off`.

## Layout

```text
config/firm.yaml        firm, matters, contacts, client profiles, word lists (the single source of truth)
db/                     migration (12 tables, append-only audit trigger) and UTBMS seed
src/server/             ingest, reconcile, match, draft, time, guidelines, entries service, export, llm
src/app, src/components the review screen and API routes
contracts/              checker contract and golden fixtures shared by TypeScript and Go
evals/                  generator, 12 days, 12 answer keys, runner, scorer
checker-go/             the Go checker
```

## What's verified, and what isn't yet

Verified on 2026-10-05 against a local Postgres: 128 TypeScript tests with none skipped, all Go tests, the production build, and the rewrite-token and LEDES export paths through the running server. Verified earlier in the build sandbox: the full review flow through the running server, and Go/TypeScript parity on real days.

Not yet: real Claude calls. The sandbox had no API key, so the Claude path (`src/server/llm/client.ts`) was checked against the SDK's types but has never run live. Run `npm run day:load -- day-03` with your key first, then the dev eval.

Changes from the design doc: the checker takes a profile per entry, because strict and default clients share a day; overlap is measured on real intervals, not one span; the drafter sets a `thin` flag; the matcher also counts the client's own name (weight 0.70); fixture text is template-rendered rather than Claude-written; and `LLM_MODE=oracle` exists for testing.
