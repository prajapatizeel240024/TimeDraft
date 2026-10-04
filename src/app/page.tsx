'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

interface FixtureRow {
  fixture_id: string;
  date: string;
  counts: { emails: number; calendar: number; docs: number; calls: number };
  day_id: string | null;
  status: string | null;
  billable_tenths: number;
}

const longDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const hours = (t: number) => `${Math.floor(t / 10)}.${t % 10}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export default function Home() {
  const router = useRouter();
  const [days, setDays] = useState<FixtureRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/fixtures')
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json()).error))))
      .then((d) => setDays(d.days))
      .catch((e: Error) => setError(e.message));
  }, []);

  async function open(row: FixtureRow) {
    if (row.day_id) return router.push(`/days/${row.day_id}`);
    setBusy(row.fixture_id);
    const res = await fetch('/api/days', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fixture_id: row.fixture_id }) });
    const body = await res.json();
    if (!res.ok) {
      setBusy(null);
      return setError(body.error);
    }
    router.push(`/days/${body.day_id}`);
  }

  return (
    <main>
      <h1 className="font-brief text-5xl tracking-tight">TimeDraft</h1>
      <p className="mt-3 max-w-xl text-lg leading-relaxed text-ink-soft">
        Pick a day. TimeDraft matches each email, meeting, document and call to a matter and drafts the time entries for review.
      </p>
      {error && <p role="alert" className="mt-6 rounded border border-redline/40 bg-redline-tint px-4 py-3 text-redline">{error}</p>}
      <section aria-label="Synthetic days" className="mt-10 rounded-sm border border-rule bg-sheet shadow-[0_1px_0_var(--color-rule)]">
        {days === null && !error && <p className="px-5 py-6 text-ink-soft">Loading days…</p>}
        <ul>
          {days?.map((d) => (
            <li key={d.fixture_id} className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-rule-soft px-5 py-4 last:border-b-0">
              <span className="font-brief min-w-64 text-lg">{longDate(d.date)}</span>
              <span className="text-sm text-ink-soft">
                {plural(d.counts.emails, 'email')}, {plural(d.counts.calendar, 'event')}, {plural(d.counts.docs, 'document')}, {plural(d.counts.calls, 'call')}
              </span>
              <span className="text-sm figures">{d.status === 'drafted' ? `${hours(d.billable_tenths)} h drafted` : d.status ? 'Loaded' : 'Not drafted yet'}</span>
              <button
                onClick={() => open(d)}
                disabled={busy !== null}
                className="ml-auto rounded-sm border border-ink px-3 py-1.5 text-sm font-medium hover:bg-ink hover:text-sheet disabled:opacity-50"
              >
                {busy === d.fixture_id ? 'Loading…' : d.day_id ? 'Open' : 'Draft this day'}
              </button>
            </li>
          ))}
        </ul>
      </section>
      <p className="mt-6 text-sm text-ink-soft">Synthetic data only. Every name, domain and phone number is fictional.</p>
    </main>
  );
}
