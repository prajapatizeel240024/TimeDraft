import type { Flag } from '@/lib/types';

const hours = (t: number) => `${Math.floor(t / 10)}.${t % 10}`;

export function TotalsBar({ totals, dayFlags }: { totals: { billable_tenths: number; non_billable_tenths: number; approved: number; total: number; queue: number; rejected: number }; dayFlags: Flag[] }) {
  const live = totals.total - totals.rejected;
  return (
    <section aria-label="Day totals" className="mt-8 flex flex-wrap items-end gap-x-10 gap-y-4 rounded-sm border border-rule bg-sheet px-5 py-4">
      <div>
        <div className="text-sm text-ink-soft">Billable</div>
        <div className="font-brief figures total-rule text-4xl leading-tight">{hours(totals.billable_tenths)}</div>
      </div>
      <div>
        <div className="text-sm text-ink-soft">Not billed</div>
        <div className="font-brief figures text-2xl">{hours(totals.non_billable_tenths)}</div>
      </div>
      <div className="text-sm">
        <span className="figures">{totals.approved}</span> of <span className="figures">{live}</span> entries approved
      </div>
      {totals.queue > 0 && <div className="text-sm text-amber">{totals.queue === 1 ? '1 activity needs a matter' : `${totals.queue} activities need a matter`}</div>}
      {dayFlags.map((f) => (
        <div key={f.code} className="basis-full text-sm text-amber">{f.message}</div>
      ))}
    </section>
  );
}
