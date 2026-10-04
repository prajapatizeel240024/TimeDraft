# TimeDraft

An AI timekeeper for one attorney's day. TimeDraft reads a day of emails, calendar events, document edits and calls, matches each one to a client matter, and drafts billable time entries in 0.1-hour units with UTBMS codes and specific narratives. It checks every entry against the client's billing guidelines, and the attorney approves, edits or rejects each one on a review screen. Every change is logged, approved time exports as LEDES 1998B, and 12 synthetic days with answer keys measure how well it works.

Synthetic data only. Every name, `.example` domain and 555-01xx phone number is fictional.

## Run it

You need Node 20.12 or newer and Docker (for Postgres). Go 1.22 or newer is optional, for the Go checker.

```bash
cp .env.example .env.local        # then add your ANTHROPIC_API_KEY
npm install
npm run db:up                     # Postgres 16 in Docker
npm run db:migrate && npm run db:seed
npm run dev                       # http://localhost:3000
```

Pick a day and TimeDraft drafts it while you watch. Day 03 (Tuesday, March 10, 2026) is the demo day: it has a duplicate call, a shared expert, a CLE webinar and a thin document session.

No API key yet? Set `LLM_MODE=oracle` in `.env.local` to use the answer-key stand-in. It answers from the eval keys, so it's for testing the plumbing and the screen, never for results. The page footer says when it's on.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | The review screen at localhost:3000 |
| `npm run day:load -- day-03` | Drafts one day from the command line (add `--llm oracle` to skip Claude) |
| `npm run test` | 111 tests, including the shared guideline fixtures and the database-backed entries service |
| `npm run typecheck` | TypeScript, strict |
| `npm run eval -- --split dev` | Scores the 8 dev days and writes `evals/reports/<time>-dev.md` |
| `npm run eval -- --split holdout` | The 4 holdout days. Run it once, at the end |
| `npm run db:reset` | Empties the app tables but keeps Claude's cached answers (`-- --all` clears those too) |
| `npm run fixtures` | Regenerates the 12 synthetic days from seed 42 |
| `cd checker-go && go test ./...` | The Go checker against the same fixtures |

Eval flags: `--threshold 0.8`, `--checker ts|go`, `--llm anthropic|oracle`, `--no-cache`.

## How it works

```text
day fixture -> ingest + estimate -> reconcile -> match (rules, then Claude) -> draft (Claude) -> time math -> guideline checks -> review -> LEDES
                                                       |
                                              below the bar: review queue
```

- **Claude judges, code counts.** Claude places activities the rules can't, groups them, picks codes and writes narratives. Durations, rounding, totals, checks and exports are plain code, and Claude's output never contains a duration.
- **Don't guess, queue it.** Claude's match is accepted only if it's confident, every quote it gives really appears in the activity, and no rule points elsewhere. Anything else waits for the attorney.
- **Round once per entry, in integers.** Billed time is `ceil(seconds / 360)` tenths, stored as an integer.
- **History can't be rewritten.** A database trigger rejects UPDATE and DELETE on `audit_events`.
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
| 0:40 | Needs a matter: Lena Park works on two matters, so it asks. Pick Halberd, and a new entry appears |
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

Verified in the build sandbox: 111 TypeScript tests, all Go tests, the production build, the full review flow through the running server, and Go/TypeScript parity on real days.

Not yet: real Claude calls. The sandbox had no API key, so the Claude path (`src/server/llm/client.ts`) was checked against the SDK's types but has never run live. Run `npm run day:load -- day-03` with your key first, then the dev eval.

Changes from the design doc: the checker takes a profile per entry, because strict and default clients share a day; overlap is measured on real intervals, not one span; the drafter sets a `thin` flag; the matcher also counts the client's own name (weight 0.70); fixture text is template-rendered rather than Claude-written; and `LLM_MODE=oracle` exists for testing.
