/**
 * Runway — the hooks module.
 *
 * Records what each turn spent, and reports how much of the rate-limit window
 * is left. Everything that decides anything lives in `core/`, as pure
 * functions; this file only wires events to them.
 *
 * The engine's static scan follows `$` through top-level declarations only, so
 * every function that takes `$` is declared here at the top of the file, and
 * the session's state is a record passed explicitly rather than a module-level
 * global.
 *
 * Capabilities: `session`, `store`, `command`, `ui`. No `fs`, no `http`, no
 * `process`, no `model`, no `prompt`, no `agent`, no `tool`, no `mcp`.
 */

import type { EngineInterface, Register, RenderInputOf } from 'claude-code';

import { DEFAULT_CONFIG, HELP_LINES, applyCommand, readConfig, type Config } from './core/command';
import { EMPTY, observe, readLedger, record, type Ledger } from './core/ledger';
import { report } from './core/format';

const STORE_LEDGER = 'ledger';
const STORE_CONFIG = 'config';
const PANE_ID = 'runway';

type Session = {
  ledger: Ledger;
  config: Config;
  /** The session's project root, read once. */
  project: string;
  /** The lines the pane is showing, when it is open. */
  pane: string[] | null;
};

function newSession(): Session {
  return { ledger: { ...EMPTY }, config: { ...DEFAULT_CONFIG }, project: '', pane: null };
}

/* ------------------------------------------------------------- engine calls */

function persistLedger($: EngineInterface, s: Session): void {
  void $.store.set(STORE_LEDGER, s.ledger).catch(() => undefined);
}

function persistConfig($: EngineInterface, s: Session): void {
  void $.store.set(STORE_CONFIG, s.config).catch(() => undefined);
}

/**
 * Takes a reading of the rate-limit windows.
 *
 * The plain call is documented as costing nothing, and it is the only way to
 * learn how much of the five-hour and weekly windows is gone — the number that
 * actually runs out on a subscription.
 */
async function readWindows($: EngineInterface, s: Session, now: number): Promise<void> {
  try {
    const usage = await $.session.usage();
    s.ledger = observe(
      s.ledger,
      usage.rateLimits.map((w) => ({
        kind: w.kind,
        percentUsed: w.percentUsed,
        ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}),
      })),
      now,
    );
  } catch {
    // A reading is a nicety; a turn must not fail over one.
  }
}

async function showPane($: EngineInterface, s: Session, lines: string[]): Promise<void> {
  s.pane = lines;
  await $.ui
    .open({ id: PANE_ID, title: 'Runway', focus: true, closeOnEscape: true, rows: lines.length + 3 })
    .catch(() => undefined);
  $.ui.invalidate('ui.render');
}

/* ------------------------------------------------------------------- hooks */

export const register: Register = (on) => {
  const s = newSession();

  on('session.start', async ($, e, next) => {
    s.ledger = readLedger(await $.store.get(STORE_LEDGER).catch(() => undefined));
    s.config = readConfig(await $.store.get(STORE_CONFIG).catch(() => undefined));
    s.project = await $.session.root().catch(() => '');

    await $.command
      .register({
        name: 'runway',
        description: 'How much of the rate-limit window is left, and what went into it.',
        argumentHint: 'today|week|month|all|quiet|loud|reset|help',
        immediate: true,
      })
      .catch(() => undefined);

    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    // A subagent's run raises its own `turn.complete`; its tokens are real and
    // belong in the ledger, but the window reading is the session's, not its.
    const usage = e.usage;
    if (usage) {
      const now = await $.clock.now().catch(() => Date.now());
      s.ledger = record(s.ledger, {
        at: now,
        project: s.project,
        model: usage.model,
        ms: e.durationMs,
        tokens: {
          input: usage.input_tokens,
          output: usage.output_tokens,
          cacheRead: usage.cache_read_input_tokens,
          cacheWrite: usage.cache_creation_input_tokens,
        },
      });
      if (e.agentId === undefined) await readWindows($, s, now);
      persistLedger($, s);
    }

    // Never our own text here: a `turn.complete` result is shown beneath the
    // answer and read by the model. Pass the chain's through verbatim.
    return next(e);
  });

  on('command.run', { command: 'runway' }, async ($, e) => {
    const outcome = applyCommand(s.config, e.args ?? '');

    if (outcome.changed) {
      s.config = outcome.config;
      persistConfig($, s);
    }

    if (outcome.action === 'set') {
      if (s.config.output === 'text') return { text: outcome.note ?? '' };
      $.ui.toast(outcome.note ?? '');
      return {};
    }

    if (outcome.action === 'reset') {
      s.ledger = { ...EMPTY };
      persistLedger($, s);
      if (s.config.output === 'text') return { text: 'runway: ledger cleared' };
      $.ui.toast('runway: ledger cleared');
      return {};
    }

    const lines =
      outcome.action === 'help'
        ? HELP_LINES.map(([command, what]) => `${command.padEnd(30)} ${what}`)
        : await (async () => {
            const now = await $.clock.now().catch(() => Date.now());
            await readWindows($, s, now);
            persistLedger($, s);
            return report(s.ledger, outcome.span ?? s.config.span, now);
          })();

    // `pane` costs nothing but only the terminal draws one; `text` is a
    // transcript row, which every surface draws and the model then reads.
    if (s.config.output === 'pane') {
      await showPane($, s, lines);
      return {};
    }
    return { text: lines.join('\n') };
  });

  on('ui.render', { component: 'Pane' }, ($, e, next) => {
    if (e.requestId !== PANE_ID || s.pane === null) return next(e);
    const { Box, Text, Button } = $.ui.resolve(e as RenderInputOf<'Pane', 'terminal'>);
    return (
      <Box flexDirection="column" paddingX={1}>
        {s.pane.map((line) => (
          <Text>{line}</Text>
        ))}
        <Button key="close" label="Close" autoFocus onPress={() => void $.ui.close({ id: PANE_ID })} />
      </Box>
    );
  });

  on('ui.close', { id: PANE_ID }, ($, e, next) => {
    s.pane = null;
    return next(e);
  });
};
