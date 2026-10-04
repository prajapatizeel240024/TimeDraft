// npm run day:load -- day-03 [--llm oracle] [--eval]
// Ingests one synthetic day and runs the pipeline, printing what it drafted.
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, loadFirm } from '@/lib/config';
import { DayFixtureSchema } from '@/lib/schemas';
import { codeLabel } from '@/lib/utbms';
import { closePools, dbUrl, getPool } from '@/server/db';
import { getDayView } from '@/server/entries/service';
import { ingestFixture } from '@/server/ingest/normalize';
import { defaultDeps, runDay } from '@/server/pipeline';
import { formatHours } from '@/server/time/rounding';

async function main() {
  loadEnv();
  const args = process.argv.slice(2);
  const fixtureId = args.find((a) => /^day-\d{2}$/.test(a));
  if (!fixtureId) throw new Error('Usage: npm run day:load -- day-03 [--llm oracle] [--eval]');
  const llmIdx = args.indexOf('--llm');
  if (llmIdx >= 0) process.env.LLM_MODE = args[llmIdx + 1];
  const pool = getPool(dbUrl(args.includes('--eval') ? 'eval' : 'dev'));
  const firm = loadFirm();
  const fx = DayFixtureSchema.parse(JSON.parse(fs.readFileSync(path.join('evals', 'days', `${fixtureId}.json`), 'utf8')));
  const { dayId, created } = await ingestFixture(pool, fx, firm.attorney.id);
  console.log(`${created ? 'Loaded' : 'Already loaded'} ${fixtureId} (${fx.date}) as ${dayId}`);
  const deps = await defaultDeps(pool);
  await runDay(pool, dayId, (e) => {
    if (e.type === 'stage') console.log(`- ${e.message}`);
    if (e.type === 'match_summary') console.log(`  ${e.auto} placed automatically, ${e.queued} need a matter, ${e.ignored} not work (${e.asked_claude} sent to ${deps.llm.name})`);
  }, deps);
  const view = await getDayView(pool, dayId, deps.checker);
  for (const m of view.matters) {
    const es = view.entries.filter((e) => e.matter_id === m.id);
    if (!es.length) continue;
    console.log(`\n${m.id} ${m.name}`);
    for (const e of es) {
      const flags = e.flags.map((f) => f.code).join(', ');
      console.log(`  ${formatHours(e.units_tenths).padStart(4)}  ${e.task_code} ${e.activity_code}  ${e.narrative}${flags ? `   [${flags}]` : ''}`);
      console.log(`        ${codeLabel(e.task_code)} / ${codeLabel(e.activity_code)}; ${e.source_count} source(s), ${Math.round(e.raw_seconds / 60)} min raw`);
    }
  }
  if (view.queue.length) {
    console.log('\nNeeds a matter:');
    for (const q of view.queue) console.log(`  ${q.title}${q.suggestion ? `  (suggested ${q.suggestion.matter_id}, ${q.suggestion.confidence})` : ''}`);
  }
  for (const f of view.dayFlags) console.log(`\nDay: ${f.message}`);
  console.log(`\nBillable ${formatHours(view.totals.billable_tenths)} h · checker ${view.checker} · drafts by ${view.llm}`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePools());
