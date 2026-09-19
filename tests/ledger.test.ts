import { describe, expect, test } from 'claude-code/testing';

import {
  EMPTY,
  HORIZON_DAYS,
  dayOf,
  groupBy,
  observe,
  projectName,
  prune,
  readLedger,
  record,
  sum,
  within,
  type Ledger,
} from '../hooks/core/ledger';

const DAY = 86_400_000;
/** A fixed local noon, so a day boundary never makes a test flap. */
const NOON = new Date(2026, 5, 15, 12, 0, 0).getTime();

const turn = (over: Partial<Parameters<typeof record>[1]> = {}) => ({
  at: NOON,
  project: 'C:/src/alpha',
  model: 'claude-opus-5',
  ms: 1000,
  tokens: { input: 100, output: 20, cacheRead: 500, cacheWrite: 50 },
  ...over,
});

describe('record', () => {
  test('the first turn makes one bucket', () => {
    const led = record({ ...EMPTY }, turn());
    expect(led.buckets.length).toBe(1);
    expect(led.buckets[0]?.turns).toBe(1);
    expect(led.buckets[0]?.input).toBe(100);
  });

  test('a second turn on the same day, project and model folds into it', () => {
    const led = record(record({ ...EMPTY }, turn()), turn());
    expect(led.buckets.length).toBe(1);
    expect(led.buckets[0]?.turns).toBe(2);
    expect(led.buckets[0]?.input).toBe(200);
    expect(led.buckets[0]?.cacheRead).toBe(1000);
    expect(led.buckets[0]?.ms).toBe(2000);
  });

  test('a different model opens its own bucket', () => {
    const led = record(record({ ...EMPTY }, turn()), turn({ model: 'claude-haiku-4-5' }));
    expect(led.buckets.length).toBe(2);
  });

  test('a different project opens its own bucket', () => {
    const led = record(record({ ...EMPTY }, turn()), turn({ project: 'C:/src/beta' }));
    expect(led.buckets.length).toBe(2);
  });

  test('a different day opens its own bucket', () => {
    const led = record(record({ ...EMPTY }, turn()), turn({ at: NOON + DAY }));
    expect(led.buckets.length).toBe(2);
  });

  test('it does not mutate the ledger it was given', () => {
    const before: Ledger = { ...EMPTY };
    record(before, turn());
    expect(before.buckets.length).toBe(0);
  });

  test('a negative duration is floored rather than subtracted', () => {
    expect(record({ ...EMPTY }, turn({ ms: -5000 })).buckets[0]?.ms).toBe(0);
  });

  test('thousands of turns stay in a handful of buckets', () => {
    // The whole point of bucketing: the store has a 4 MiB ceiling.
    let led: Ledger = { ...EMPTY };
    for (let i = 0; i < 5000; i++) led = record(led, turn());
    expect(led.buckets.length).toBe(1);
    expect(led.buckets[0]?.turns).toBe(5000);
  });
});

describe('prune', () => {
  test('a bucket past the horizon is dropped', () => {
    const old = record({ ...EMPTY }, turn({ at: NOON - (HORIZON_DAYS + 5) * DAY }));
    expect(prune(old, NOON).buckets.length).toBe(0);
  });

  test('a bucket inside the horizon is kept', () => {
    const recent = record({ ...EMPTY }, turn({ at: NOON - 5 * DAY }));
    expect(prune(recent, NOON).buckets.length).toBe(1);
  });

  test('recording prunes as it goes, so history cannot grow without bound', () => {
    let led = record({ ...EMPTY }, turn({ at: NOON - (HORIZON_DAYS + 5) * DAY }));
    led = record(led, turn({ at: NOON }));
    expect(led.buckets.length).toBe(1);
    expect(led.buckets[0]?.day).toBe(dayOf(NOON));
  });
});

describe('within', () => {
  const spread = (): Ledger => {
    let led: Ledger = { ...EMPTY };
    for (const daysAgo of [0, 3, 10, 40]) led = record(led, turn({ at: NOON - daysAgo * DAY }));
    return led;
  };

  test('today is only today', () => {
    expect(within(spread(), 'today', NOON).length).toBe(1);
  });

  test('a week counts back seven whole days', () => {
    expect(within(spread(), 'week', NOON).length).toBe(2);
  });

  test('a month counts back thirty', () => {
    expect(within(spread(), 'month', NOON).length).toBe(3);
  });

  test('all is everything kept', () => {
    expect(within(spread(), 'all', NOON).length).toBe(4);
  });
});

describe('sum and groupBy', () => {
  test('sum adds every class and reports the total', () => {
    const led = record(record({ ...EMPTY }, turn()), turn({ model: 'claude-haiku-4-5' }));
    const totals = sum(led.buckets);
    expect(totals.turns).toBe(2);
    expect(totals.input).toBe(200);
    expect(totals.tokens).toBe(2 * (100 + 20 + 500 + 50));
  });

  test('an empty set sums to zero rather than throwing', () => {
    expect(sum([]).tokens).toBe(0);
  });

  test('groups come back biggest first', () => {
    let led = record({ ...EMPTY }, turn({ project: 'C:/src/small' }));
    led = record(led, turn({ project: 'C:/src/big', tokens: { input: 9000, output: 0, cacheRead: 0, cacheWrite: 0 } }));
    const groups = groupBy(led.buckets, 'project');
    expect(groups[0]?.name).toBe('C:/src/big');
  });
});

describe('observe', () => {
  test('a reading is kept with the time it was taken', () => {
    const led = observe({ ...EMPTY }, [{ kind: 'five_hour', percentUsed: 30 }], NOON);
    expect(led.windows[0]).toEqual({ kind: 'five_hour', percentUsed: 30, readAt: NOON });
  });

  test('a newer reading replaces the older one of the same kind', () => {
    let led = observe({ ...EMPTY }, [{ kind: 'five_hour', percentUsed: 30 }], NOON);
    led = observe(led, [{ kind: 'five_hour', percentUsed: 55 }], NOON + 1000);
    expect(led.windows.length).toBe(1);
    expect(led.windows[0]?.percentUsed).toBe(55);
  });

  test('different kinds live side by side', () => {
    const led = observe(
      { ...EMPTY },
      [
        { kind: 'five_hour', percentUsed: 30 },
        { kind: 'seven_day', percentUsed: 8 },
      ],
      NOON,
    );
    expect(led.windows.length).toBe(2);
  });

  test('no readings leaves the ledger exactly as it was', () => {
    const before: Ledger = { ...EMPTY };
    expect(observe(before, [], NOON)).toBe(before);
  });
});

describe('readLedger', () => {
  test('junk gives an empty ledger rather than throwing', () => {
    for (const junk of [undefined, null, 0, '', 'ledger', [], true]) {
      expect(readLedger(junk).buckets).toEqual([]);
    }
  });

  test('a good record survives a round trip through JSON', () => {
    const led = observe(record({ ...EMPTY }, turn()), [{ kind: 'five_hour', percentUsed: 12 }], NOON);
    expect(readLedger(JSON.parse(JSON.stringify(led)))).toEqual(led);
  });

  test('a bucket with no usable day is dropped, the rest are kept', () => {
    const stored = {
      v: 1,
      buckets: [
        { day: 'whenever', project: 'x', model: 'm', input: 1, output: 1, cacheRead: 0, cacheWrite: 0, turns: 1, ms: 0 },
        { day: '2026-06-15', project: 'x', model: 'm', input: 5, output: 1, cacheRead: 0, cacheWrite: 0, turns: 1, ms: 0 },
      ],
      windows: [],
    };
    const led = readLedger(stored);
    expect(led.buckets.length).toBe(1);
    expect(led.buckets[0]?.input).toBe(5);
  });

  test('negative or non-numeric counts fall back to zero', () => {
    const led = readLedger({
      v: 1,
      buckets: [{ day: '2026-06-15', project: 'x', model: 'm', input: -9, output: 'lots', turns: 1 }],
      windows: [],
    });
    expect(led.buckets[0]?.input).toBe(0);
    expect(led.buckets[0]?.output).toBe(0);
  });

  test('a window with no kind is dropped', () => {
    expect(readLedger({ v: 1, buckets: [], windows: [{ percentUsed: 10 }] }).windows).toEqual([]);
  });
});

describe('projectName', () => {
  test('shows the last segment of a path', () => {
    expect(projectName('C:/Users/me/src/alpha')).toBe('alpha');
    expect(projectName('/home/me/src/beta')).toBe('beta');
    expect(projectName('C:\\Users\\me\\src\\gamma')).toBe('gamma');
  });

  test('no project reads as none rather than empty', () => {
    expect(projectName('')).toBe('(none)');
  });
});

test('dayOf is a local calendar day, stable across the same day', () => {
  const morning = new Date(2026, 5, 15, 1, 0, 0).getTime();
  const night = new Date(2026, 5, 15, 23, 30, 0).getTime();
  expect(dayOf(morning)).toBe(dayOf(night));
  expect(dayOf(morning)).toBe('2026-06-15');
});
