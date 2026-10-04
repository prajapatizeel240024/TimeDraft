// Billed time is integer tenths of an hour. Never floating point.

/** Rounds raw seconds up to the next tenth of an hour: 1-360 s -> 1, 361 s -> 2. Zero is invalid. */
export function toTenths(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds <= 0) throw new Error(`toTenths needs a positive whole number of seconds, got ${seconds}`);
  return Math.ceil(seconds / 360);
}

/** 12 -> "1.2", 5 -> "0.5". */
export function formatHours(tenths: number): string {
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}
