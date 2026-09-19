import { describe, expect, test } from 'claude-code/testing';

import { bar, compact, oneLine, report, until, valueOf, windowLines } from '../hooks/core/format';
import { EMPTY, observe, record, type Ledger } from '../hooks/core/ledger';

const DAY = 86_400_000;
const NOON = new Date(2026, 5, 15, 12, 0, 0).getTime();

const tokens = (i: number, o: number, cr = 0, cw = 0) => ({ input: i, output: o, cacheRead: cr, cacheWrite: cw });

function busy(): Ledger {
  let led: Ledger = { ...EMPTY };
  for (let i = 0; i < 10; i++) {
    led = record(led, { at: NOON, project: 'C:/src/alpha', model: 'claude-opus-5', ms: 40_000, tokens: tokens(2000, 800, 12_000, 500) });
  }
  for (let i = 0; i < 4; i++) {
    led = record(led, { at: NOON, project: 'C:/src/beta', model: 'claude-sonnet-5', ms: 10_000, tokens: tokens(900, 300, 4000, 100) });
  }
  return observe(
    led,
    [
      { kind: 'five_hour', percentUsed: 34, resetsAt: new Date(NOON + 2 * 3_600_000).toISOString() },
      { kind: 'seven_day', percentUsed: 61 },
    ],
    NOON,
  );
}

describe('compact', () => {
  test('small numbers are exact', () => {
    expect(compact(0)).toBe('0');
    expect(compact(903)).toBe('903');
  });

  test('thousands keep one decimal while it carries information', () => {
    expect(compact(1200)).toBe('1.2k');
    expect(compact(41_200)).toBe('41.2k');
  });

  test('past a hundred thousand the decimal is noise and goes', () => {
    expect(compact(739_900)).toBe('740k');
    expect(compact(100_000)).toBe('100k');
  });

  test('millions keep one decimal', () => {
    expect(compact(1_240_000)).toBe('1.2M');
  });
});

describe('until', () => {
  test('a gap that has passed reads as now', () => {
    expect(until(0)).toBe('now');
    expect(until(-5000)).toBe('now');
  });

  test('minutes, then hours, then days', () => {
    expect(until(14 * 60_000)).toBe('14m');
    expect(until(2 * 3_600_000 + 11 * 60_000)).toBe('2h 11m');
    expect(until(3 * DAY + 5 * 3_600_000)).toBe('3d 5h');
  });

  test('a round gap does not carry a zero remainder', () => {
    expect(until(3 * DAY)).toBe('3d');
    expect(until(2 * 3_600_000)).toBe('2h');
  });
});

describe('bar', () => {
  test('empty and full are the ends', () => {
    expect(bar(0)).toBe('░░░░░░░░░░');
    expect(bar(100)).toBe('██████████');
  });

  test('it fills in proportion and never overflows', () => {
    expect(bar(50).length).toBe(10);
    expect(bar(150).length).toBe(10);
    expect(bar(-5)).toBe('░░░░░░░░░░');
  });
});

describe('windowLines', () => {
  test('with no reading it says so rather than showing zero', () => {
    // Zero used would be a lie: the truth is that nothing has been read yet.
    const lines = windowLines({ ...EMPTY }, NOON);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('no window reading');
  });

  test('a reading names the window in words and shows when it resets', () => {
    const line = windowLines(busy(), NOON).join('\n');
    expect(line).toContain('5-hour');
    expect(line).toContain('34%');
    expect(line).toContain('resets in 2h');
    expect(line).toContain('weekly');
  });

  test('an old reading is marked stale', () => {
    const led = observe({ ...EMPTY }, [{ kind: 'five_hour', percentUsed: 10 }], NOON - 4 * 3_600_000);
    expect(windowLines(led, NOON)[0]).toContain('stale');
  });
});

describe('valueOf', () => {
  test('a priced ledger totals in dollars', () => {
    const value = valueOf(busy(), 'today', NOON);
    expect(value.usd).toBeGreaterThan(0);
    expect(value.complete).toBe(true);
  });

  test('one unpriced model makes the total a floor, not a total', () => {
    const led = record(busy(), { at: NOON, project: 'x', model: 'claude-unknown-9', ms: 0, tokens: tokens(1000, 1000) });
    expect(valueOf(led, 'today', NOON).complete).toBe(false);
  });
});

describe('report', () => {
  test('an empty ledger says nothing was recorded, and does not throw', () => {
    const lines = report({ ...EMPTY }, 'today', NOON).join('\n');
    expect(lines).toContain('nothing recorded today');
  });

  test('the window comes first, because it is what runs out', () => {
    expect(report(busy(), 'today', NOON)[0]).toContain('5-hour');
  });

  test('the totals name the span, the tokens and the turns', () => {
    const lines = report(busy(), 'today', NOON).join('\n');
    expect(lines).toContain('today');
    expect(lines).toContain('14 turns');
  });

  test('projects and models are broken out, biggest first', () => {
    const lines = report(busy(), 'today', NOON);
    const projects = lines.findIndex((l) => l.includes('alpha'));
    const beta = lines.findIndex((l) => l.includes('beta'));
    expect(projects).toBeGreaterThan(-1);
    expect(beta).toBeGreaterThan(projects);
    expect(lines.join('\n')).toContain('opus-5');
  });

  test('the price is marked as a rate, never as a bill', () => {
    // On a subscription nothing is billed per token; saying otherwise would
    // be the tool's one chance to mislead.
    expect(report(busy(), 'today', NOON).join('\n')).toContain('at API rates');
  });

  test('the cache hit rate is reported, since nobody else shows it', () => {
    expect(report(busy(), 'today', NOON).join('\n')).toContain('cache');
  });

  test('a span with nothing in it still shows the window', () => {
    const old = observe(
      record({ ...EMPTY }, { at: NOON - 40 * DAY, project: 'x', model: 'claude-opus-5', ms: 0, tokens: tokens(1, 1) }),
      [{ kind: 'five_hour', percentUsed: 5 }],
      NOON,
    );
    const lines = report(old, 'today', NOON).join('\n');
    expect(lines).toContain('5-hour');
    expect(lines).toContain('nothing recorded');
  });

  test('every line is a string with no stray undefined', () => {
    for (const span of ['today', 'week', 'month', 'all'] as const) {
      for (const line of report(busy(), span, NOON)) {
        expect(typeof line).toBe('string');
        expect(line).not.toContain('undefined');
        expect(line).not.toContain('NaN');
      }
    }
  });
});

test('oneLine fits a status line and leads with the window', () => {
  const line = oneLine(busy(), NOON);
  expect(line).toContain('34% of 5h');
  expect(line.length).toBeLessThan(60);
});
