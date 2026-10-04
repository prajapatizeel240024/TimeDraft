// Duration estimates for activities that don't carry their own duration. Tuned on dev days only.
export const EST = {
  sentBaseSeconds: 120, // opening, addressing, re-reading
  sentSecondsPerWord: 1.5, // about 40 words a minute to write
  secondsPerAttachment: 30,
  sentCapSeconds: 1800,
  readSecondsPerWord: 0.3, // about 200 words a minute to read
  readMinSeconds: 60,
  readCapSeconds: 900,
} as const;

export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}

export function estimateSentEmail(body: string, attachments: number): number {
  const raw = EST.sentBaseSeconds + EST.sentSecondsPerWord * countWords(body) + EST.secondsPerAttachment * attachments;
  return Math.min(EST.sentCapSeconds, Math.round(raw));
}

export function estimateReadEmail(body: string, opened: boolean): number {
  if (!opened) return 0;
  const raw = Math.max(EST.readMinSeconds, EST.readSecondsPerWord * countWords(body));
  return Math.min(EST.readCapSeconds, Math.round(raw));
}
