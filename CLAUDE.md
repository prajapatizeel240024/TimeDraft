# TimeDraft: rules for Claude Code

Read README.md, then docs/ARCHITECTURE.md if it exists (export the design doc there). They are the source of truth for names, schemas and file layout.

## Hard rules
- Never commit, push, create branches, touch a shared or remote database, or deploy. Leave every change uncommitted in the working tree.
- Edit existing files. If a new file seems necessary, stop and ask first. Generated files (lockfile, next-env.d.ts, node_modules, .next, evals/reports) are fine.
- No probe or scratch files. Check things with stdout-only commands (node -e, npx tsx -e, psql -c). If a temp file is truly unavoidable, ask first and delete it before you finish.
- Databases: local Postgres only (time_draft_dev, time_draft_eval). src/server/db.ts refuses any host other than localhost or 127.0.0.1.
- Synthetic data only: the .example domains and 555-01xx numbers in config/firm.yaml. Never add real names, firms, domains or numbers.
- Stay inside the session's folders. A Go session works only in checker-go/ and reads only contracts/ and the docs.
- One Claude Code session per working tree at a time. A final verify comes from a session that wrote nothing in the tree.

## Invariants
- Claude never returns durations. All time math lives in src/server/time: billed tenths = ceil(seconds / 360), once per entry, stored as an integer.
- Only src/server/entries/service.ts writes time_entries, entry_flags and audit_events, and every change writes exactly one audit row in the same transaction.
- audit_events is append-only (database trigger).
- Every Claude call goes through src/server/llm/client.ts: structured outputs via output_config.format, zod validation, llm_calls logging, response cache.
- Below MATCH_THRESHOLD, or when Claude's quotes aren't in the text, an activity goes to the review queue. Never auto-assign it.
- src/server/guidelines/rules.ts and checker-go/internal/guidelines/rules.go change together, and both must pass contracts/fixtures/guidelines.json.
- LLM_MODE=oracle is for tests only. Its numbers are never reported as results.
- Everything binds to 127.0.0.1. Nothing is deployed, published or exposed.
- A narrative counts as Claude's rewrite only with a valid rewrite_token.
- MATCH_THRESHOLD must parse to a number above 0 and at most 1.
- The oracle never runs on holdout.
- CHECKER_URL must be a loopback address.

## Commands
npm run db:up | db:migrate | db:seed | db:reset
npm run day:load -- day-03 [--llm oracle]
npm run dev | typecheck | test | build
npm run eval -- --split dev [--checker go] [--no-cache]
cd checker-go && go vet ./... && go test ./...

## Done means
Typecheck clean, tests green, the session's checks pass, and a closing summary that lists every file created or changed.
