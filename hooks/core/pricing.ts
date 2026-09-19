/**
 * What a turn's tokens are worth, at first-party API rates.  [PURE]
 *
 * A subscription does not bill per token, so for most people this is not a
 * bill — it is a way to compare one session with another, and to see which
 * project or model is eating the rate-limit window. The report says so rather
 * than presenting these figures as money owed.
 *
 * Rates are dollars per million tokens, cached 2026-06-24. They move; a model
 * this table does not know is reported in tokens only, never guessed at.
 */

export type Rate = {
  /** Uncached input. */
  input: number;
  /** Output. */
  output: number;
  /**
   * Cache reads, where the model charges its own rate rather than a multiple
   * of `input`; absent means `input * CACHE_READ`.
   */
  cacheRead?: number;
};

/** Writing to the cache costs more than plain input. */
export const CACHE_WRITE = 1.25;
/** Reading from it costs much less. */
export const CACHE_READ = 0.1;

/**
 * Dollars per million tokens, by the model id the API reports.
 *
 * Keyed by prefix, not by exact id: the engine reports what the API sent, and
 * a dated snapshot (`claude-opus-5-20260401`) must price like its family.
 */
export const RATES: Readonly<Record<string, Rate>> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5-1': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

/** The four token counts a turn reports. */
export type Tokens = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export const NO_TOKENS: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Every token in one record, which is what the rate-limit window actually feels. */
export const totalTokens = (t: Tokens): number => t.input + t.output + t.cacheRead + t.cacheWrite;

/**
 * The rate for a model id, or null when the table does not know it.
 *
 * The longest matching prefix wins, so `claude-opus-5` does not swallow a
 * future `claude-opus-5-1`.
 */
export function rateFor(model: string): Rate | null {
  let best: Rate | null = null;
  let bestLength = 0;
  for (const [prefix, rate] of Object.entries(RATES)) {
    if (model.startsWith(prefix) && prefix.length > bestLength) {
      best = rate;
      bestLength = prefix.length;
    }
  }
  return best;
}

/**
 * What these tokens would cost at API rates, or null for an unknown model.
 *
 * Null is the honest answer and the report prints tokens alone for it. A
 * guessed price on a model nobody has priced is worse than no price.
 */
export function costOf(model: string, t: Tokens): number | null {
  const rate = rateFor(model);
  if (!rate) return null;
  const perToken = rate.input / 1_000_000;
  return (
    t.input * perToken +
    t.output * (rate.output / 1_000_000) +
    t.cacheRead * (rate.cacheRead !== undefined ? rate.cacheRead / 1_000_000 : perToken * CACHE_READ) +
    t.cacheWrite * perToken * CACHE_WRITE
  );
}

/** A short name for a model id, for a table that has to fit a terminal. */
export function shortModel(model: string): string {
  const name = model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
  return name.length <= 18 ? name : `${name.slice(0, 17)}…`;
}
