'use client';

import { useState } from 'react';
import type { Profile, RewriteSuggestion, Words } from '@/lib/types';
import { codeLabel } from '@/lib/utbms';
import type { EntryView } from '@/server/entries/service';
import { EntryEditor, type EntrySave } from './EntryEditor';
import { FlagChip } from './FlagChip';

const hours = (t: number) => `${Math.floor(t / 10)}.${t % 10}`;

export interface RowActions {
  approve: (overrideReason?: string) => Promise<void>;
  reject: (reason: string) => Promise<void>;
  reopen: () => Promise<void>;
  save: (s: EntrySave) => Promise<void>;
  rewrite: (hint: string) => Promise<RewriteSuggestion>;
  showSources: () => void;
  showHistory: () => void;
}

export function EntryRow({ entry, profile, words, actions }: { entry: EntryView; profile: Profile; words: Words; actions: RowActions }) {
  const [mode, setMode] = useState<'view' | 'edit' | 'rewrite'>('view');
  const [asking, setAsking] = useState<null | 'override' | 'reject'>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const blocking = entry.flags.filter((f) => f.severity === 'block' && !f.override_reason);
  const draft = entry.status === 'draft';

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setAsking(null);
      setReason('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`arrive grid grid-cols-[4.5rem_1fr] border-b border-rule-soft last:border-b-0 ${entry.status === 'approved' ? 'bg-approve-tint/50' : ''}`}>
      <div className={`figures border-r border-rule px-3 py-4 text-right font-brief text-xl ${entry.status === 'rejected' ? 'text-ink-soft line-through' : ''}`}>{hours(entry.units_tenths)}</div>
      <div className="min-w-0 px-4 py-4">
        <p className={`font-brief text-[1.0625rem] leading-relaxed ${entry.status === 'rejected' ? 'text-ink-soft line-through' : ''}`}>{entry.narrative}</p>
        <p className="mt-1 text-xs text-ink-soft">
          <span title={codeLabel(entry.task_code)}>{entry.task_code} {codeLabel(entry.task_code)}</span>
          <span aria-hidden> / </span>
          <span title={codeLabel(entry.activity_code)}>{entry.activity_code} {codeLabel(entry.activity_code)}</span>
          {!entry.billable && <span className="ml-2 font-medium text-ink">Not billed</span>}
          {entry.status === 'approved' && <span className="ml-2 font-medium text-approve">Approved</span>}
          {entry.status === 'rejected' && <span className="ml-2 font-medium">Rejected</span>}
        </p>
        {entry.flags.length > 0 && (
          <ul className="mt-2 space-y-1">
            {entry.flags.map((f, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 text-sm">
                <FlagChip flag={f} />
                <span className="text-ink-soft">{f.override_reason ? `Approved anyway: ${f.override_reason}` : f.message}</span>
                {draft && f.code === 'VAGUE_NARRATIVE' && mode === 'view' && (
                  <button onClick={() => setMode('rewrite')} className="text-sm font-medium underline underline-offset-2">Rewrite</button>
                )}
                {draft && f.code === 'NON_BILLABLE_ADMIN' && entry.billable && mode === 'view' && (
                  <button onClick={() => run(() => actions.save({ units_tenths: entry.units_tenths, task_code: entry.task_code, activity_code: entry.activity_code, narrative: entry.narrative, billable: false }))} className="text-sm font-medium underline underline-offset-2">Mark not billed</button>
                )}
              </li>
            ))}
          </ul>
        )}
        {mode !== 'view' && (
          <EntryEditor entry={entry} profile={profile} words={words} startWithRewrite={mode === 'rewrite'} onCancel={() => setMode('view')} onRewrite={actions.rewrite} onSave={async (s) => { await actions.save(s); setMode('view'); }} />
        )}
        {mode === 'view' && (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            {draft && (
              <button disabled={busy} onClick={() => (blocking.length ? setAsking('override') : run(() => actions.approve()))} className="rounded-sm bg-ink px-3 py-1 font-medium text-sheet disabled:opacity-50">Approve</button>
            )}
            {draft && <button onClick={() => setMode('edit')} className="hover:underline">Edit</button>}
            {draft && <button onClick={() => setAsking('reject')} className="hover:underline">Reject</button>}
            {!draft && <button disabled={busy} onClick={() => run(actions.reopen)} className="hover:underline">Reopen</button>}
            <button onClick={actions.showSources} className="text-ink-soft hover:underline">Why this entry</button>
            <button onClick={actions.showHistory} className="text-ink-soft hover:underline">History</button>
          </div>
        )}
        {asking && (
          <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void run(() => (asking === 'reject' ? actions.reject(reason) : actions.approve(reason))); }}>
            <label className="grow text-sm">
              {asking === 'reject' ? 'Why reject it?' : `This entry has ${blocking.length === 1 ? 'a blocking flag' : 'blocking flags'}. Why approve it anyway?`}
              <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} className="mt-1 block w-full rounded-sm border border-rule bg-sheet px-2 py-1.5" />
            </label>
            <button disabled={busy || !reason.trim()} className="rounded-sm border border-ink px-3 py-1.5 text-sm disabled:opacity-50">{asking === 'reject' ? 'Reject' : 'Approve anyway'}</button>
            <button type="button" onClick={() => setAsking(null)} className="px-2 py-1.5 text-sm text-ink-soft hover:underline">Cancel</button>
          </form>
        )}
        {error && <p role="alert" className="mt-2 text-sm text-redline">{error}</p>}
      </div>
    </li>
  );
}
