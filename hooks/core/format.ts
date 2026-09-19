/**
 * The report, as lines of text.  [PURE]
 *
 * Lines rather than a tree, because the same report has to work in two very
 * different places: a `Pane` in the terminal, and a `command.run` answer where
 * the plugin cannot draw at all. Both take strings.
 */

import { costOf, shortModel, type Tokens } from './pricing';
import { groupBy, projectName, sum, within, type Bucket, type Ledger, type Span, type Totals } from './ledger';

/**
 * `412k`, `740k`, `1.2M`, `903` — a token count that fits a column.
 *
 * The decimal is dropped once the number is big enough not to need it: at
 * three digits of thousands, a tenth of a thousand is noise.
 */
export function compact(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 100_000) return `${Math.round(n / 100) / 10}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${Math.round(n / 100_000) / 10}M`;
}

/** `2h 11m`, `14m`, `3d`, `now` — a gap in words, for a reset time. */
export function until(ms: number): string {
  if (ms <= 0) return 'now';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}

/** A ten-cell bar, so a percentage reads at a glance. */
export function bar(percent: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/** The window names the API reports, in the words a person uses. */
function windowName(kind: string): string {
  if (kind === 'five_hour') return '5-hour';
  if (kind === 'seven_day') return 'weekly';
  if (kind === 'spend_limit') return 'spend';
  return kind;
}

const money = (usd: number): string => (usd >= 10 ? `$${usd.toFixed(0)}` : `$${usd.toFixed(2)}`);

/**
 * What a set of buckets is worth, and whether every model in it had a price.
 *
 * A single unpriced model makes the whole figure a floor rather than a total,
 * and the report says `+` rather than pretending otherwise.
 */
export function valueOfBuckets(buckets: readonly Bucket[]): { usd: number; complete: boolean } {
  let usd = 0;
  let complete = true;
  for (const b of buckets) {
    const priced = costOf(b.model, b as Tokens);
    if (priced === null) complete = false;
    else usd += priced;
  }
  return { usd, complete };
}

export function valueOf(ledger: Ledger, span: Span, now: number): { usd: number; complete: boolean } {
  return valueOfBuckets(within(ledger, span, now));
}

const SPAN_WORDS: Record<Span, string> = { today: 'today', week: 'last 7 days', month: 'last 30 days', all: 'all time' };

/**
 * One row of a breakdown: what it is, its tokens, its turns and its worth.
 *
 * The price sits beside the tokens because the two do not track each other —
 * the same count is worth five times as much on Opus as on Sonnet, and a
 * breakdown that showed only tokens would hide exactly the comparison someone
 * opens this for.
 */
function groupRow(label: string, group: { buckets: readonly Bucket[]; totals: Totals }): string {
  const value = valueOfBuckets(group.buckets);
  const worth = value.usd > 0 ? `${money(value.usd)}${value.complete ? '' : '+'}` : '—';
  return (
    `  ${label.padEnd(20).slice(0, 20)}` +
    ` ${compact(group.totals.tokens).padStart(6)}` +
    ` ${String(group.totals.turns).padStart(4)} turns` +
    ` ${worth.padStart(8)}`
  );
}

function totalsLine(label: string, totals: Totals, value: { usd: number; complete: boolean }): string {
  const turns = `${totals.turns} turn${totals.turns === 1 ? '' : 's'}`;
  const worth = value.usd > 0 ? ` · ${money(value.usd)}${value.complete ? '' : '+'} at API rates` : '';
  return `${label.padEnd(12)} ${compact(totals.tokens)} tokens · ${turns}${worth}`;
}

/** The rate-limit windows, which are the headline for anyone on a subscription. */
export function windowLines(ledger: Ledger, now: number): string[] {
  if (ledger.windows.length === 0) {
    return ['no window reading yet — it arrives with the next answer'];
  }
  const order = ['five_hour', 'seven_day', 'spend_limit'];
  const sorted = ledger.windows
    .slice()
    .sort((a, b) => (order.indexOf(a.kind) + 9) % 9 - ((order.indexOf(b.kind) + 9) % 9));

  return sorted.map((w) => {
    const resets = w.resetsAt ? ` · resets in ${until(Date.parse(w.resetsAt) - now)}` : '';
    const stale = now - w.readAt > 3_600_000 ? ' (stale)' : '';
    return `${windowName(w.kind).padEnd(8)} ${bar(w.percentUsed)} ${w.percentUsed}%${resets}${stale}`;
  });
}

/**
 * The whole report.
 *
 * The window comes first on purpose: on a subscription nothing is billed per
 * token, so what actually runs out is the window, and the dollar figure is
 * there to compare one day with another rather than to be paid.
 */
export function report(ledger: Ledger, span: Span, now: number): string[] {
  const lines: string[] = [...windowLines(ledger, now), ''];

  const buckets = within(ledger, span, now);
  const totals = sum(buckets);
  const value = valueOf(ledger, span, now);

  if (totals.turns === 0) {
    lines.push(`nothing recorded ${SPAN_WORDS[span]}`);
    return lines;
  }

  lines.push(totalsLine(SPAN_WORDS[span], totals, value));

  const projects = groupBy(buckets, 'project').slice(0, 5);
  if (projects.length > 1) {
    lines.push('', 'by project');
    for (const g of projects) lines.push(groupRow(projectName(g.name), g));
  }

  // Always broken out, even for a single model: which model answered is the
  // one thing that changes what the same token count is worth, and a day that
  // was all Opus reads very differently from one that was all Sonnet.
  const models = groupBy(buckets, 'model');
  lines.push('', 'by model');
  for (const g of models.slice(0, 6)) lines.push(groupRow(shortModel(g.name), g));

  // Cache reads are the cheap ones; a healthy session is mostly them, and a
  // number nobody shows you is the easiest one to leave broken.
  const cacheable = totals.cacheRead + totals.cacheWrite + totals.input;
  if (cacheable > 0) {
    const hit = Math.round((totals.cacheRead / cacheable) * 100);
    lines.push('', `cache ${hit}% of input read from cache`);
  }

  return lines;
}

/** The one line a status line or a spinner can hold. */
export function oneLine(ledger: Ledger, now: number): string {
  const five = ledger.windows.find((w) => w.kind === 'five_hour');
  const today = sum(within(ledger, 'today', now));
  const head = five ? `${five.percentUsed}% of 5h` : 'no reading';
  return `${head} · ${compact(today.tokens)} today`;
}
