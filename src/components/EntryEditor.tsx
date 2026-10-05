'use client';

import { useMemo, useState } from 'react';
import type { Profile, RewriteSuggestion, Words } from '@/lib/types';
import { ACTIVITY_CODES, TASK_CODES } from '@/lib/utbms';
import type { EntryView } from '@/server/entries/service';
import { checkEntries } from '@/server/guidelines/rules';
import { FlagChip } from './FlagChip';

export interface EntrySave {
  units_tenths: number;
  task_code: string;
  activity_code: string;
  narrative: string;
  billable: boolean;
  rewrite_token?: string; // sent only while the narrative is still exactly Claude's suggestion
}

const hours = (t: number) => `${Math.floor(t / 10)}.${t % 10}`;

export function EntryEditor({ entry, profile, words, startWithRewrite, onSave, onCancel, onRewrite }: {
  entry: EntryView;
  profile: Profile;
  words: Words;
  startWithRewrite: boolean;
  onSave: (s: EntrySave) => Promise<void>;
  onCancel: () => void;
  onRewrite: (hint: string) => Promise<RewriteSuggestion>;
}) {
  const [units, setUnits] = useState(entry.units_tenths);
  const [task, setTask] = useState(entry.task_code);
  const [act, setAct] = useState(entry.activity_code);
  const [narrative, setNarrative] = useState(entry.narrative);
  const [billable, setBillable] = useState(entry.billable);
  const [suggestion, setSuggestion] = useState<{ narrative: string; token: string } | null>(null);
  const [question, setQuestion] = useState<string | null>(null);
  const [hint, setHint] = useState('');
  const [rewriting, setRewriting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The same rules the server runs, as the attorney types. The server checks again on save.
  const live = useMemo(
    () =>
      checkEntries({
        profiles: { p: profile },
        words,
        daily_max_tenths: 1000,
        entries: [{ id: entry.id, profile: 'p', units_tenths: units, task_code: task, activity_code: act, narrative, thin_context: narrative === entry.narrative && entry.thin_context, billable, source_categories: ['billable'], intervals: [] }],
      }),
    [profile, words, entry, units, task, act, narrative, billable],
  );

  async function rewrite() {
    setRewriting(true);
    setError(null);
    try {
      const out = await onRewrite(hint);
      if (out.status === 'needs_detail') {
        setQuestion(out.question);
        setNote(null);
      } else {
        setNarrative(out.narrative);
        setSuggestion({ narrative: out.narrative, token: out.token });
        setQuestion(null);
        setNote(`Suggested by Claude from ${out.facts_used.length === 1 ? '1 fact' : `${out.facts_used.length} facts`} in the sources${hint ? ' and your answer' : ''}. Check it before saving.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRewriting(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const text = narrative.trim();
      // Claude's token goes only with Claude's exact text: once the attorney changes it, the save is their own edit.
      const token = suggestion && text === suggestion.narrative.trim() ? suggestion.token : '';
      await onSave({ units_tenths: units, task_code: task, activity_code: act, narrative: text, billable, ...(token ? { rewrite_token: token } : {}) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 rounded-sm border border-rule bg-desk/40 p-4">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <span className="block text-xs text-ink-soft">Hours</span>
          <div className="mt-1 flex items-center">
            <button type="button" aria-label="Subtract 0.1 hours" onClick={() => setUnits((u) => Math.max(1, u - 1))} className="h-8 w-8 rounded-l-sm border border-rule bg-sheet">−</button>
            <output aria-live="polite" className="figures flex h-8 w-14 items-center justify-center border-y border-rule bg-sheet font-brief text-lg">{hours(units)}</output>
            <button type="button" aria-label="Add 0.1 hours" onClick={() => setUnits((u) => Math.min(240, u + 1))} className="h-8 w-8 rounded-r-sm border border-rule bg-sheet">+</button>
          </div>
        </div>
        <label className="text-xs text-ink-soft">
          Task
          <select value={task} onChange={(e) => setTask(e.target.value)} className="mt-1 block max-w-64 rounded-sm border border-rule bg-sheet px-2 py-1.5 text-sm text-ink">
            {TASK_CODES.map((c) => <option key={c.code} value={c.code}>{c.code} {c.label}</option>)}
          </select>
        </label>
        <label className="text-xs text-ink-soft">
          Activity
          <select value={act} onChange={(e) => setAct(e.target.value)} className="mt-1 block rounded-sm border border-rule bg-sheet px-2 py-1.5 text-sm text-ink">
            {ACTIVITY_CODES.map((c) => <option key={c.code} value={c.code}>{c.code} {c.label}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 pb-1.5 text-sm">
          <input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} /> Bill this time
        </label>
      </div>
      <label className="mt-4 block text-xs text-ink-soft">
        Narrative
        <textarea value={narrative} onChange={(e) => { setNarrative(e.target.value); setNote(null); }} rows={3} className="font-brief mt-1 block w-full rounded-sm border border-rule bg-sheet px-3 py-2 text-base leading-relaxed text-ink" />
      </label>
      {note && <p className="mt-1 text-sm text-ink-soft">{note}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2" aria-live="polite">
        {live.length ? live.map((f, i) => <span key={i} className="flex items-center gap-2 text-sm"><FlagChip flag={{ ...f, override_reason: null }} /><span className="text-ink-soft">{f.message}</span></span>) : <span className="text-sm text-approve">Passes this client&apos;s guidelines.</span>}
      </div>
      <div className="mt-4 rounded-sm border border-rule-soft bg-sheet px-3 py-3">
        {question ? (
          <div className="flex flex-wrap items-end gap-2">
            <label className="grow text-sm">
              <span className="font-medium">Claude asks:</span> {question}
              <input autoFocus={startWithRewrite} value={hint} onChange={(e) => setHint(e.target.value)} placeholder="A few words are enough" className="mt-1 block w-full rounded-sm border border-rule px-2 py-1.5" />
            </label>
            <button type="button" onClick={rewrite} disabled={rewriting || !hint.trim()} className="rounded-sm border border-ink px-3 py-1.5 text-sm disabled:opacity-50">{rewriting ? 'Rewriting…' : 'Rewrite'}</button>
          </div>
        ) : (
          <button type="button" autoFocus={startWithRewrite} onClick={rewrite} disabled={rewriting} className="text-sm font-medium underline underline-offset-2 disabled:opacity-50">
            {rewriting ? 'Asking Claude…' : 'Rewrite with Claude'}
          </button>
        )}
        <p className="mt-1 text-xs text-ink-soft">Claude uses only the sources and your answer. If they don&apos;t say what the work was for, it asks.</p>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-redline">{error}</p>}
      <div className="mt-4 flex gap-3">
        <button type="button" onClick={save} disabled={saving || !narrative.trim()} className="rounded-sm bg-ink px-4 py-1.5 text-sm font-medium text-sheet disabled:opacity-50">{saving ? 'Saving…' : 'Save changes'}</button>
        <button type="button" onClick={onCancel} className="px-2 text-sm text-ink-soft hover:underline">Cancel</button>
      </div>
    </div>
  );
}
