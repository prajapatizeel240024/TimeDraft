import type { QueueItem } from '@/server/entries/service';

const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
const KIND: Record<string, string> = { email: 'Email', calendar: 'Meeting', doc: 'Document', call: 'Call' };

export function ReviewQueue({ items, matters, busy, onResolve }: { items: QueueItem[]; matters: { id: string; short_name: string }[]; busy: boolean; onResolve: (activityId: string, choice: { matter_id: string } | { category: 'admin' | 'personal' | 'ignore' }) => void }) {
  if (!items.length) return null;
  const name = (id: string) => matters.find((m) => m.id === id)?.short_name ?? id;
  return (
    <section aria-labelledby="queue-heading" className="mt-8 rounded-sm border border-amber/40 bg-amber-tint/60 px-5 py-4">
      <h2 id="queue-heading" className="font-brief text-xl">Needs a matter</h2>
      <p className="mt-1 text-sm text-ink-soft">TimeDraft wasn&apos;t sure enough to place these, so it asked instead of guessing.</p>
      <ul className="mt-3 space-y-4">
        {items.map((q) => (
          <li key={q.activity_id} className="arrive rounded-sm border border-rule bg-sheet px-4 py-3">
            <div className="flex flex-wrap items-baseline gap-x-3">
              <span className="text-xs text-ink-soft">{KIND[q.source] ?? q.source}, {clock(q.started_at)}</span>
              <span className="font-medium">{q.title}</span>
            </div>
            {q.suggestion && q.suggestion.matter_id !== 'NONE' && (
              <p className="mt-1 text-sm text-ink-soft">
                Claude suggests {name(q.suggestion.matter_id)}, {Math.round(q.suggestion.confidence * 100)}% sure: {q.suggestion.why}
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {matters.map((m) => (
                <button key={m.id} disabled={busy} onClick={() => onResolve(q.activity_id, { matter_id: m.id })} className={`rounded-sm border px-2.5 py-1 text-sm hover:bg-ink hover:text-sheet disabled:opacity-50 ${q.suggestion?.matter_id === m.id ? 'border-ink font-medium' : 'border-rule'}`}>
                  {m.short_name}
                </button>
              ))}
              <button disabled={busy} onClick={() => onResolve(q.activity_id, { category: 'admin' })} className="rounded-sm border border-rule px-2.5 py-1 text-sm hover:bg-ink hover:text-sheet disabled:opacity-50">Admin</button>
              <button disabled={busy} onClick={() => onResolve(q.activity_id, { category: 'personal' })} className="rounded-sm border border-rule px-2.5 py-1 text-sm hover:bg-ink hover:text-sheet disabled:opacity-50">Personal</button>
              <button disabled={busy} onClick={() => onResolve(q.activity_id, { category: 'ignore' })} className="rounded-sm px-2.5 py-1 text-sm text-ink-soft underline-offset-2 hover:underline disabled:opacity-50">Not work</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
