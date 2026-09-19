/**
 * `/runway` and its arguments.  [PURE]
 */

import type { Span } from './ledger';

/** Where the report goes. */
export type Output =
  /** Into the transcript, which every surface draws — and the model reads. */
  | 'text'
  /** Into a pane, which costs nothing and only the terminal draws. */
  | 'pane';

export type Config = {
  /**
   * Where `/runway` puts its answer.
   *
   * `text` by default, and the choice is a real one: a transcript row is the
   * only thing the desktop app draws, but it becomes context the model reads
   * on its next turn. A pane costs nothing and only exists in the terminal.
   */
  output: Output;
  /** The span `/runway` reports when asked for none. */
  span: Span;
};

export const DEFAULT_CONFIG: Config = { output: 'text', span: 'today' };

export type Outcome = {
  config: Config;
  changed: boolean;
  /** What the command asks the shell to do. */
  action: 'report' | 'help' | 'reset' | 'set';
  /** The span to report, when the action is `report`. */
  span?: Span;
  /** A line to confirm a change with. */
  note?: string;
};

const SPANS: readonly Span[] = ['today', 'week', 'month', 'all'];
const isSpan = (s: string): s is Span => (SPANS as readonly string[]).includes(s);

export function applyCommand(config: Config, rawArgs: string): Outcome {
  const words = rawArgs.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const verb = words[0];
  const arg = words[1];

  if (verb === undefined) return { config, changed: false, action: 'report', span: config.span };
  if (isSpan(verb)) return { config, changed: false, action: 'report', span: verb };

  switch (verb) {
    case 'quiet':
      return config.output === 'pane'
        ? { config, changed: false, action: 'set', note: 'runway: already quiet' }
        : {
            config: { ...config, output: 'pane' },
            changed: true,
            action: 'set',
            note: 'runway: reports go to a pane now — terminal only, no tokens',
          };

    case 'loud':
      return config.output === 'text'
        ? { config, changed: false, action: 'set', note: 'runway: already loud' }
        : {
            config: { ...config, output: 'text' },
            changed: true,
            action: 'set',
            note: 'runway: reports go to the transcript now — every surface, a few tokens',
          };

    case 'default': {
      if (arg === undefined || !isSpan(arg)) return { config, changed: false, action: 'help' };
      return {
        config: { ...config, span: arg },
        changed: true,
        action: 'set',
        note: `runway: /runway reports ${arg} by default`,
      };
    }

    case 'reset':
      return { config, changed: false, action: 'reset' };

    case 'help':
      return { config, changed: false, action: 'help' };

    default:
      return { config, changed: false, action: 'help' };
  }
}

/** Reads a stored config back, field by field. */
export function readConfig(raw: unknown): Config {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_CONFIG };
  const r = raw as Record<string, unknown>;
  return {
    output: r['output'] === 'pane' ? 'pane' : 'text',
    span: typeof r['span'] === 'string' && isSpan(r['span']) ? r['span'] : DEFAULT_CONFIG.span,
  };
}

export const HELP_LINES: readonly (readonly [string, string])[] = [
  ['/runway', 'the window, and what has gone into it'],
  ['/runway today|week|month|all', 'report one span'],
  ['/runway default <span>', 'which span a bare /runway reports'],
  ['/runway quiet', 'report into a pane: no tokens, terminal only'],
  ['/runway loud', 'report into the transcript: every surface, a few tokens'],
  ['/runway reset', 'forget the ledger'],
  ['/runway help', 'this list'],
];
