import { describe, expect, it } from 'vitest';
import { EST, countWords, estimateReadEmail, estimateSentEmail } from '@/server/ingest/estimate';

describe('email duration estimates', () => {
  it('writing: base + per word + per attachment', () => {
    expect(estimateSentEmail('one two three four', 1)).toBe(EST.sentBaseSeconds + 4 * EST.sentSecondsPerWord + EST.secondsPerAttachment);
  });
  it('writing is capped', () => expect(estimateSentEmail('word '.repeat(5000), 0)).toBe(EST.sentCapSeconds));
  it('reading has a floor and a cap', () => {
    expect(estimateReadEmail('short note', true)).toBe(EST.readMinSeconds);
    expect(estimateReadEmail('word '.repeat(10000), true)).toBe(EST.readCapSeconds);
  });
  it('an unopened email took no time', () => expect(estimateReadEmail('anything at all', false)).toBe(0));
  it('counts words with letters or digits only', () => expect(countWords('Dana, -- see 2 items!')).toBe(4));
});
