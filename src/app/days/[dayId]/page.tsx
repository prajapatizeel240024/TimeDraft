'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RewriteOutput } from '@/lib/types';
import type { DayView, EntryView } from '@/server/entries/service';
import type { PipelineEvent } from '@/server/pipeline';
import type { EntrySave } from '@/components/EntryEditor';
import { EntryRow } from '@/components/EntryRow';
import { HistoryDrawer } from '@/components/HistoryDrawer';
import { ReviewQueue } from '@/components/ReviewQueue';
import { SourcesDrawer } from '@/components/SourcesDrawer';
import { TotalsBar } from '@/components/TotalsBar';

const longDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const hours = (t: number) => `${Math.floor(t / 10)}.${t % 10}`;

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed with ${res.status}`);
  return data as T;
}

export default function DayPage() {
  const { dayId } = useParams<{ dayId: string }>();
  const [view, setView] = useState<DayView | null>(null);
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyQueue, setBusyQueue] = useState(false);
  const [drawer, setDrawer] = useState<{ kind: 'sources' | 'history'; entry: EntryView } | null>(null);
  const started = useRef(false);

  const load = useCallback(async () => {
    const v = await api<DayView>(`/api/days/${dayId}`);
    setView(v);
    return v;
  }, [dayId]);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`/api/days/${dayId}/run`, { method: 'POST' });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          if (!chunk.startsWith('data: ')) continue;
          const e = JSON.parse(chunk.slice(6)) as PipelineEvent;
          if (e.type === 'stage') setStage(e.message);
          if (e.type === 'match_summary') setStage(`${e.auto} activities placed, ${e.queued} need a matter. Drafting entries…`);
          if (e.type === 'entry') setView((v) => (v ? { ...v, entries: [...v.entries.filter((x) => x.id !== e.entry.id), e.entry] } : v));
          if (e.type === 'review_item') setView((v) => (v ? { ...v, queue: [...v.queue.filter((x) => x.activity_id !== e.item.activity_id), e.item] } : v));
          if (e.type === 'error') setError(e.message);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
      setStage(null);
      await load().catch(() => undefined);
    }
  }, [dayId, load]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    load()
      .then((v) => (v.day.status !== 'drafted' ? run() : undefined))
      .catch((err: Error) => setError(err.message));
  }, [load, run]);

  async function act(fn: () => Promise<unknown>) {
    await fn();
    await load();
  }

  async function resolve(activityId: string, choice: { matter_id: string } | { category: 'admin' | 'personal' | 'ignore' }) {
    setBusyQueue(true);
    setError(null);
    try {
      await act(() => api(`/api/activities/${activityId}/resolve`, 'POST', choice));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyQueue(false);
    }
  }

  async function exportLedes(matterId: string) {
    setError(null);
    const res = await fetch(`/api/matters/${matterId}/ledes?day=${dayId}`);
    if (!res.ok) return setError((await res.json()).error);
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'invoice.txt';
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!view) {
    return (
      <main>
        <Link href="/" className="text-sm text-ink-soft hover:underline">All days</Link>
        {error ? <p role="alert" className="mt-6 text-redline">{error}</p> : <p className="mt-6 text-ink-soft">Loading the day…</p>}
      </main>
    );
  }

  return (
    <main>
      <Link href="/" className="text-sm text-ink-soft hover:underline">All days</Link>
      <h1 className="font-brief mt-4 text-4xl tracking-tight sm:text-5xl">{longDate(view.day.work_date)}</h1>
      <p className="mt-2 text-ink-soft">{view.attorney.display_name}, {view.attorney.firm}</p>
      {running && <p role="status" className="mt-5 text-sm">{stage ?? 'Starting…'}</p>}
      {error && (
        <p role="alert" className="mt-5 rounded-sm border border-redline/40 bg-redline-tint px-4 py-3 text-sm text-redline">
          {error}
          {!running && view.day.status === 'failed' && (
            <button onClick={run} className="ml-3 font-medium underline underline-offset-2">Try again</button>
          )}
        </p>
      )}
      <TotalsBar totals={view.totals} dayFlags={view.dayFlags} />
      <ReviewQueue items={view.queue} matters={view.matters} busy={busyQueue} onResolve={resolve} />

      {view.matters.map((m) => {
        const entries = view.entries.filter((e) => e.matter_id === m.id);
        if (!entries.length) return null;
        const sum = entries.filter((e) => e.billable && e.status !== 'rejected').reduce((s, e) => s + e.units_tenths, 0);
        const canExport = entries.some((e) => e.status === 'approved' && e.billable);
        return (
          <section key={m.id} aria-labelledby={`m-${m.id}`} className="mt-10">
            <div className="flex flex-wrap items-end justify-between gap-3 border-b-2 border-ink pb-2">
              <div>
                <h2 id={`m-${m.id}`} className="font-brief text-2xl">{m.name}</h2>
                <p className="mt-0.5 text-xs text-ink-soft">
                  Matter {m.id}, client matter {m.client_matter_id}
                  {m.profile.block_billing === 'block' ? '. Strict guidelines: entries over ' + hours(m.profile.max_entry_tenths) + ' h are flagged.' : ''}
                </p>
              </div>
              <div className="flex items-end gap-5">
                <button onClick={() => exportLedes(m.id)} disabled={!canExport} title={canExport ? 'Download a LEDES 1998B invoice of the approved entries' : 'Approve an entry first'} className="text-sm underline underline-offset-2 disabled:no-underline disabled:opacity-40">
                  Export LEDES
                </button>
                <span className="font-brief figures text-2xl">{hours(sum)}</span>
              </div>
            </div>
            <ul className="rounded-b-sm border-x border-b border-rule bg-sheet">
              {entries.map((e) => (
                <EntryRow
                  key={`${e.id}:${e.version}`}
                  entry={e}
                  profile={view.profiles[e.matter_id]}
                  words={view.words}
                  actions={{
                    approve: (reason) => act(() => api(`/api/entries/${e.id}/approve`, 'POST', { version: e.version, ...(reason ? { override_reason: reason } : {}) })),
                    reject: (reason) => act(() => api(`/api/entries/${e.id}/reject`, 'POST', { version: e.version, reason })),
                    reopen: () => act(() => api(`/api/entries/${e.id}/reopen`, 'POST', { version: e.version })),
                    save: (s: EntrySave) => act(() => api(`/api/entries/${e.id}`, 'PATCH', { version: e.version, ...s })),
                    rewrite: (hint) => api<RewriteOutput>(`/api/entries/${e.id}/rewrite`, 'POST', { hint }),
                    showSources: () => setDrawer({ kind: 'sources', entry: e }),
                    showHistory: () => setDrawer({ kind: 'history', entry: e }),
                  }}
                />
              ))}
            </ul>
          </section>
        );
      })}

      {!running && view.entries.length === 0 && view.day.status === 'drafted' && <p className="mt-10 text-ink-soft">No billable work was found for this day.</p>}

      {view.notBilled.length > 0 && (
        <details className="mt-10 text-sm">
          <summary className="cursor-pointer text-ink-soft">Left out of the bill ({view.notBilled.length})</summary>
          <ul className="mt-2 space-y-1 pl-4">
            {view.notBilled.map((n) => <li key={n.activity_id}>{n.title}: <span className="text-ink-soft">{n.reason}</span></li>)}
          </ul>
        </details>
      )}

      <footer className="mt-14 border-t border-rule pt-4 text-xs text-ink-soft">
        Guideline checks ran in {view.checker === 'go@1' ? 'the Go service' : 'TypeScript'} ({view.checker}). Drafts by {view.llm === 'oracle' ? 'the answer-key stand-in, for testing only' : 'Claude'}. Synthetic data only.
      </footer>

      {drawer?.kind === 'sources' && <SourcesDrawer entryId={drawer.entry.id} why={drawer.entry.why} onClose={() => setDrawer(null)} />}
      {drawer?.kind === 'history' && <HistoryDrawer entryId={drawer.entry.id} onClose={() => setDrawer(null)} />}
    </main>
  );
}
