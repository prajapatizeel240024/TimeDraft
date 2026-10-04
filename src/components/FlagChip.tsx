import type { EntryFlagView } from '@/server/entries/service';

const LABELS: Record<string, string> = {
  BLOCK_BILLING: 'Several tasks',
  VAGUE_NARRATIVE: 'Vague',
  LONG_ENTRY: 'Long',
  NON_BILLABLE_ADMIN: 'Admin time',
  OVERLAP: 'Overlap',
  DAILY_TOTAL: 'Long day',
  UNGROUNDED_TERM: 'Name not in sources',
};

export function flagLabel(code: string): string {
  return LABELS[code] ?? code;
}

export function FlagChip({ flag }: { flag: Pick<EntryFlagView, 'code' | 'severity' | 'message' | 'override_reason'> }) {
  const overridden = Boolean(flag.override_reason);
  const tone = overridden ? 'border-rule text-ink-soft bg-sheet' : flag.severity === 'block' ? 'border-redline/40 bg-redline-tint text-redline' : 'border-amber/30 bg-amber-tint text-amber';
  return (
    <span title={flag.message} className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 text-xs font-medium ${tone}`}>
      {flagLabel(flag.code)}
      {overridden && <span className="ml-1 font-normal">(approved anyway)</span>}
    </span>
  );
}
