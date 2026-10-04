'use client';

import { useEffect, useState } from 'react';

interface Source {
  activity_id: string;
  source: string;
  started_at: string;
  seconds: number;
  est_seconds: number;
  duration_basis: string;
  title: string;
  snippet: string;
  match: { method: string | null; confidence: number | null; evidence: { signal?: string; value?: string }[] };
}

const KIND: Record<string, string> = { email: 'Email', calendar: 'Meeting', doc: 'Document', call: 'Call' };
const BASIS: Record<string, string> = { exact: 'exact', scheduled: 'scheduled', measured: 'measured', estimated: 'estimated', none: 'no time' };
const SIGNALS: Record<string, string> = {
  matter_number: 'matter number', doc_folder: 'matter folder', client_domain: 'client domain', contact_phone: 'contact phone', party_domain: 'other side',
  client_name: 'client named', party_name: 'party named', shared_contact: 'shared contact', keyword: 'keyword', claude_quote: 'Claude quote',
};
const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
const minutes = (s: number) => (s < 60 ? `${s} s` : `${Math.round(s / 60)} min`);

export function SourcesDrawer({ entryId, why, onClose }: { entryId: string; why: string; onClose: () => void }) {
  const [sources, setSources] = useState<Source[] | null>(null);
  useEffect(() => {
    fetch(`/api/entries/${entryId}/sources`).then((r) => r.json()).then((d) => setSources(d.sources));
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [entryId, onClose]);

  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-ink/20" onClick={onClose}>
      <aside role="dialog" aria-modal="true" aria-label="Why this entry" onClick={(e) => e.stopPropagation()} className="h-full w-full max-w-md overflow-y-auto border-l border-rule bg-sheet px-6 py-6">
        <div className="flex items-baseline justify-between">
          <h2 className="font-brief text-2xl">Why this entry</h2>
          <button autoFocus onClick={onClose} className="text-sm text-ink-soft hover:underline">Close</button>
        </div>
        {why && <p className="mt-2 text-sm leading-relaxed">{why}</p>}
        <p className="mt-1 text-xs text-ink-soft">Time comes from these activities, never from the model.</p>
        <ul className="mt-5 space-y-4">
          {sources?.map((s) => (
            <li key={s.activity_id} className="rounded-sm border border-rule-soft px-4 py-3">
              <div className="flex items-baseline justify-between gap-3 text-xs text-ink-soft">
                <span>{KIND[s.source] ?? s.source}, {clock(s.started_at)}</span>
                <span className="figures">{minutes(s.seconds)} counted, {BASIS[s.duration_basis] ?? s.duration_basis}</span>
              </div>
              <div className="mt-1 font-medium">{s.title}</div>
              {s.snippet && <p className="mt-1 line-clamp-3 text-sm text-ink-soft">{s.snippet}</p>}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {s.match.method === 'attorney' && <span className="rounded-sm bg-desk px-1.5 py-0.5 text-xs">placed by the attorney</span>}
                {s.match.evidence.filter((e) => e.signal && e.signal in SIGNALS).slice(0, 5).map((e, i) => (
                  <span key={i} className="rounded-sm bg-desk px-1.5 py-0.5 text-xs">{SIGNALS[e.signal!]}: {e.value}</span>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
