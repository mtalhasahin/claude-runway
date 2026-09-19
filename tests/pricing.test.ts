import { describe, expect, test } from 'claude-code/testing';

import { CACHE_READ, CACHE_WRITE, RATES, costOf, rateFor, shortModel, totalTokens } from '../hooks/core/pricing';

/** The kit has no toBeCloseTo, so money is compared at six decimals. */
const cents = (n: number | null): number | null => (n === null ? null : Math.round(n * 1e6) / 1e6);

const tokens = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
});

describe('rateFor', () => {
  test('finds a model by its exact id', () => {
    expect(rateFor('claude-opus-5')).toEqual({ input: 5, output: 25 });
    expect(rateFor('claude-haiku-4-5')).toEqual({ input: 1, output: 5 });
  });

  test('a dated snapshot prices like its family', () => {
    // The engine reports whatever the API sent, which may carry a date.
    expect(rateFor('claude-sonnet-5-20260401')).toEqual({ input: 2, output: 10 });
  });

  test('the longest matching prefix wins', () => {
    // `claude-fable-5` must not swallow `claude-fable-5-1`, which is priced
    // differently on cache reads.
    expect(rateFor('claude-fable-5-1')?.cacheRead).toBe(0.25);
    expect(rateFor('claude-fable-5')?.cacheRead).toBe(undefined);
  });

  test('a model the table does not know is null, not a guess', () => {
    expect(rateFor('claude-something-7')).toBe(null);
    expect(rateFor('')).toBe(null);
  });
});

describe('costOf', () => {
  test('a million input tokens costs the input rate', () => {
    expect(cents(costOf('claude-opus-5', tokens(1_000_000, 0)))).toBe(5);
  });

  test('a million output tokens costs the output rate', () => {
    expect(cents(costOf('claude-opus-5', tokens(0, 1_000_000)))).toBe(25);
  });

  test('cache writes cost more than plain input', () => {
    const write = costOf('claude-opus-5', tokens(0, 0, 0, 1_000_000)) ?? 0;
    expect(cents(write)).toBe(5 * CACHE_WRITE);
    expect(write).toBeGreaterThan(costOf('claude-opus-5', tokens(1_000_000, 0)) ?? 0);
  });

  test('cache reads cost a fraction of input', () => {
    const read = costOf('claude-opus-5', tokens(0, 0, 1_000_000)) ?? 0;
    expect(cents(read)).toBe(5 * CACHE_READ);
    expect(read).toBeLessThan(costOf('claude-opus-5', tokens(1_000_000, 0)) ?? 0);
  });

  test('a model with its own cache-read rate uses it instead of the multiple', () => {
    expect(cents(costOf('claude-fable-5-1', tokens(0, 0, 1_000_000)))).toBe(0.25);
  });

  test('an unknown model has no price at all', () => {
    expect(costOf('claude-something-7', tokens(1_000_000, 1_000_000))).toBe(null);
  });

  test('nothing spent costs nothing', () => {
    expect(costOf('claude-opus-5', tokens(0, 0))).toBe(0);
  });
});

describe('the rate table', () => {
  test('every rate is positive and output costs more than input', () => {
    for (const [model, rate] of Object.entries(RATES)) {
      expect(rate.input).toBeGreaterThan(0);
      expect(rate.output).toBeGreaterThan(rate.input);
      if (rate.cacheRead !== undefined) expect(rate.cacheRead).toBeLessThan(rate.input);
      expect(model.startsWith('claude-')).toBe(true);
    }
  });
});

test('totalTokens counts every class, because the window feels all of them', () => {
  expect(totalTokens(tokens(1, 2, 4, 8))).toBe(15);
});

describe('shortModel', () => {
  test('drops the vendor prefix', () => {
    expect(shortModel('claude-opus-5')).toBe('opus-5');
  });

  test('drops a date suffix', () => {
    expect(shortModel('claude-sonnet-5-20260401')).toBe('sonnet-5');
  });

  test('a very long name is cut to fit a column', () => {
    expect(shortModel(`claude-${'x'.repeat(40)}`).length).toBeLessThanOrEqual(18);
  });
});
