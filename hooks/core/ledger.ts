/**
 * The ledger: what was spent, by day, project and model.  [PURE]
 *
 * The store is a JSON file with a 4 MiB ceiling, and a busy week is thousands
 * of turns, so nothing is kept per turn. Every turn folds into a bucket keyed
 * `day|project|model`, and days past the horizon are dropped on write. That
 * keeps the file small and bounded no matter how long the plugin runs.
 */

import { NO_TOKENS, totalTokens, type Tokens } from './pricing';

/** The schema version, for a migration that has not been needed yet. */
export const VERSION = 1;

/** How many days of history to keep. Older buckets are dropped as they age out. */
export const HORIZON_DAYS = 90;

export type Bucket = Tokens & {
  /** `YYYY-MM-DD`, in the machine's own timezone. */
  day: string;
  /** The session's project root, or `''` when it had none. */
  project: string;
  /** The model id as the API reported it. */
  model: string;
  /** Turns folded into this bucket. */
  turns: number;
  /** Wall-clock time those turns took, in milliseconds. */
  ms: number;
};

/** The last reading of a rate-limit window, kept so a report has one without an API call. */
export type Window = {
  kind: string;
  percentUsed: number;
  resetsAt?: string;
  /** When this reading was taken, ms since the epoch. */
  readAt: number;
};

export type Ledger = {
  v: number;
  buckets: Bucket[];
  windows: Window[];
};

export const EMPTY: Ledger = { v: VERSION, buckets: [], windows: [] };

/** `YYYY-MM-DD` for a timestamp, in the machine's own timezone. */
export function dayOf(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const key = (b: Pick<Bucket, 'day' | 'project' | 'model'>): string => `${b.day}|${b.project}|${b.model}`;

/** The last path segment of a project root, which is what a report can show. */
export function projectName(root: string): string {
  if (!root) return '(none)';
  const parts = root.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? root;
}

/**
 * Folds one turn into the ledger.
 *
 * Returns a new ledger; the input is left alone, so a caller can compare the
 * two to decide whether a write is worth making.
 */
export function record(
  ledger: Ledger,
  entry: { at: number; project: string; model: string; tokens: Tokens; ms: number },
): Ledger {
  const day = dayOf(entry.at);
  const id = key({ day, project: entry.project, model: entry.model });

  const buckets = ledger.buckets.slice();
  const at = buckets.findIndex((b) => key(b) === id);
  const held = at === -1 ? undefined : buckets[at];

  const next: Bucket = {
    day,
    project: entry.project,
    model: entry.model,
    input: (held?.input ?? 0) + entry.tokens.input,
    output: (held?.output ?? 0) + entry.tokens.output,
    cacheRead: (held?.cacheRead ?? 0) + entry.tokens.cacheRead,
    cacheWrite: (held?.cacheWrite ?? 0) + entry.tokens.cacheWrite,
    turns: (held?.turns ?? 0) + 1,
    ms: (held?.ms ?? 0) + Math.max(0, entry.ms),
  };

  if (at === -1) buckets.push(next);
  else buckets[at] = next;

  return prune({ ...ledger, v: VERSION, buckets }, entry.at);
}

/** Drops buckets older than the horizon, so the store cannot grow without bound. */
export function prune(ledger: Ledger, now: number): Ledger {
  const oldest = dayOf(now - HORIZON_DAYS * 86_400_000);
  const buckets = ledger.buckets.filter((b) => b.day >= oldest);
  return buckets.length === ledger.buckets.length ? ledger : { ...ledger, buckets };
}

/** Keeps the newest reading of each window kind. */
export function observe(ledger: Ledger, windows: readonly Omit<Window, 'readAt'>[], at: number): Ledger {
  if (windows.length === 0) return ledger;
  const kept = ledger.windows.filter((w) => !windows.some((fresh) => fresh.kind === w.kind));
  return { ...ledger, windows: [...kept, ...windows.map((w) => ({ ...w, readAt: at }))] };
}

export type Totals = Tokens & { turns: number; ms: number; tokens: number };

export const NO_TOTALS: Totals = { ...NO_TOKENS, turns: 0, ms: 0, tokens: 0 };

/** Sums a set of buckets. */
export function sum(buckets: readonly Bucket[]): Totals {
  const out = { ...NO_TOTALS };
  for (const b of buckets) {
    out.input += b.input;
    out.output += b.output;
    out.cacheRead += b.cacheRead;
    out.cacheWrite += b.cacheWrite;
    out.turns += b.turns;
    out.ms += b.ms;
  }
  out.tokens = totalTokens(out);
  return out;
}

export type Span = 'today' | 'week' | 'month' | 'all';

/** The buckets inside a span, counted back from `now` in whole local days. */
export function within(ledger: Ledger, span: Span, now: number): Bucket[] {
  if (span === 'all') return ledger.buckets.slice();
  const days = span === 'today' ? 1 : span === 'week' ? 7 : 30;
  const from = dayOf(now - (days - 1) * 86_400_000);
  return ledger.buckets.filter((b) => b.day >= from);
}

export type Group = { name: string; buckets: Bucket[]; totals: Totals };

/**
 * Groups buckets by one of their keys and sums each group, biggest first.
 *
 * The group keeps its buckets as well as its totals: a price depends on which
 * model earned each token, so anything that wants a group's worth has to go
 * back to the buckets rather than to the sum.
 */
export function groupBy(buckets: readonly Bucket[], by: 'project' | 'model' | 'day'): Group[] {
  const groups = new Map<string, Bucket[]>();
  for (const b of buckets) {
    const name = b[by];
    const held = groups.get(name);
    if (held) held.push(b);
    else groups.set(name, [b]);
  }
  return [...groups.entries()]
    .map(([name, group]) => ({ name, buckets: group, totals: sum(group) }))
    .sort((a, b) => b.totals.tokens - a.totals.tokens);
}

/** Reads whatever the store held into a ledger, defensively. */
export function readLedger(raw: unknown): Ledger {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...EMPTY };
  const record_ = raw as Record<string, unknown>;

  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');

  const buckets: Bucket[] = [];
  if (Array.isArray(record_['buckets'])) {
    for (const item of record_['buckets']) {
      if (typeof item !== 'object' || item === null) continue;
      const b = item as Record<string, unknown>;
      const day = str(b['day']);
      // A bucket with no day cannot be placed in time, so it cannot be reported.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      buckets.push({
        day,
        project: str(b['project']),
        model: str(b['model']),
        input: num(b['input']),
        output: num(b['output']),
        cacheRead: num(b['cacheRead']),
        cacheWrite: num(b['cacheWrite']),
        turns: num(b['turns']),
        ms: num(b['ms']),
      });
    }
  }

  const windows: Window[] = [];
  if (Array.isArray(record_['windows'])) {
    for (const item of record_['windows']) {
      if (typeof item !== 'object' || item === null) continue;
      const w = item as Record<string, unknown>;
      const kind = str(w['kind']);
      if (!kind) continue;
      const resetsAt = str(w['resetsAt']);
      windows.push({
        kind,
        percentUsed: num(w['percentUsed']),
        ...(resetsAt ? { resetsAt } : {}),
        readAt: num(w['readAt']),
      });
    }
  }

  return { v: VERSION, buckets, windows };
}
