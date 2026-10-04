import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatHours, toTenths } from '@/server/time/rounding';

const fx = JSON.parse(fs.readFileSync('contracts/fixtures/rounding.json', 'utf8')) as { cases: { seconds: number; tenths: number }[]; invalid: number[] };

describe('rounding (shared fixtures)', () => {
  for (const c of fx.cases) it(`${c.seconds} s -> ${c.tenths} tenths`, () => expect(toTenths(c.seconds)).toBe(c.tenths));
  for (const bad of fx.invalid) it(`rejects ${bad} s`, () => expect(() => toTenths(bad)).toThrow());
  it('rejects fractions of a second', () => expect(() => toTenths(12.5)).toThrow());
  it('formats tenths as hours', () => expect([1, 5, 10, 12, 240].map(formatHours)).toEqual(['0.1', '0.5', '1.0', '1.2', '24.0']));
});
