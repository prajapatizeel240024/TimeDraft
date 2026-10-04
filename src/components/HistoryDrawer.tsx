'use client';

import { useEffect, useState } from 'react';

interface Event {
  id: string;
  actor: string;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  created_at: string;
}

const time = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
const ACTIONS: Record<string, string> = { created: 'Drafted', edited: 'Edited', rewritten: 'Rewritten', approved: 'Approved', rejected: 'Rejected', reopened: 'Reopened' };
const FIELDS: Record<string, string> = { narrative: 'Narrative', units_tenths: 'Hours', task_code: 'Task code', activity_code: 'Activity code', billable: 'Billed', status: 'Status', thin_context: 'Sources lack a purpose' };
const show = (k: string, v: unknown) => (k === 'units_tenths' && typeof v === 'number' ? `${Math.floor(v / 10)}.${v % 10}` : String(v));

export function HistoryDrawer({ entryId, onClose }: { entryId: string; onClose: () => void }) {
  const [events, setEvents] = useState<Event[] | null>(null);
  useEffect(() => {
    fetch(`/api/entries/${entryId}/history`).then((r) => r.json()).then((d) => setEvents(d.events));
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [entryId, onClose]);

  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-ink/20" onClick={onClose}>
      <aside role="dialog" aria-modal="true" aria-label="Entry history" onClick={(e) => e.stopPropagation()} className="h-full w-full max-w-md overflow-y-auto border-l border-rule bg-sheet px-6 py-6">
        <div className="flex items-baseline justify-between">
          <h2 className="font-brief text-2xl">History</h2>
          <button autoFocus onClick={onClose} className="text-sm text-ink-soft hover:underline">Close</button>
        </div>
        <p className="mt-1 text-sm text-ink-soft">Every change, newest first. This log can&apos;t be edited or deleted.</p>
        <ol className="mt-5 space-y-5">
          {events?.map((e) => (
            <li key={e.id} className="border-l-2 border-rule pl-4">
              <div className="text-sm"><span className="font-medium">{ACTIONS[e.action] ?? e.action}</span> by {e.actor}</div>
              <div className="text-xs text-ink-soft">{time(e.created_at)}</div>
              {e.reason && <p className="mt-1 text-sm">Reason: {e.reason}</p>}
              {e.action !== 'created' && e.before && e.after && (
                <dl className="mt-2 space-y-2 text-sm">
                  {Object.keys(e.after).filter((k) => k in FIELDS && k in (e.before ?? {})).map((k) => (
                    <div key={k}>
                      <dt className="text-xs text-ink-soft">{FIELDS[k]}</dt>
                      <dd className={k === 'narrative' ? 'font-brief' : ''}>
                        <del className="text-redline decoration-redline">{show(k, e.before?.[k])}</del>
                        <ins className="ml-1 block no-underline">{show(k, e.after?.[k])}</ins>
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              {e.action === 'created' && e.after && <p className="font-brief mt-1 text-sm text-ink-soft">{String(e.after.narrative ?? '')}</p>}
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}
