# Runway

**How much of your rate-limit window is left, and what went into it.**

On a subscription nothing is billed per token, so the number that actually runs out is not money —
it's the five-hour and weekly windows. Claude Code knows how full they are and when they reset, but
only for the session you're in, and only while you're in it. Runway keeps the reading, records what
each turn spent, and tells you which project and which model have been eating it.

```
/runway
```

```
5-hour   ███░░░░░░░ 34% · resets in 2h 11m
weekly   ██████░░░░ 61% · resets in 3d

today        754k tokens · 55 turns · $1.70 at API rates

by project
  claude-waitroom        657k   38 turns    $1.61
  payra                 97.1k   17 turns    $0.09

by model
  opus-5                 657k   38 turns    $1.61
  sonnet-5              82.5k   11 turns    $0.08
  haiku-4-5             14.6k    6 turns    $0.01

cache 85% of input read from cache
```

Every row carries its own price, not just its tokens — the comparison is the point. An Opus token is
worth five times a Sonnet one on output, so 657k against 82.5k is an eightfold gap in tokens and a
twentyfold gap in money. Tokens alone would say the first and bury the second.

The dollar figure is there to compare one day with another, not to be paid — it says *at API rates*
because that is what it is. A model the price table doesn't know is reported in tokens only, and the
total is marked `+` rather than quietly under-counting.

---

## What it costs

Recording costs nothing: it adds nothing to the system prompt or the tool list (`claude plugin
details runway` reports `~0 tok` always-on), and the hook reads the usage the turn already carried,
writes it to the store, and passes the turn through untouched.

Asking for a report costs about **120–170 tokens** in `loud` mode, because the answer is a
transcript row the model then reads — and keeps reading for the rest of the session. `/runway quiet`
puts it in a pane instead and costs nothing at all, in the terminal. Details below under
[loud and quiet](#loud-and-quiet).

---

## What it records

Every `turn.complete` carries the four token counts the API reported and the model that answered.
Runway folds each turn into a bucket keyed by **day, project and model**, so a thousand turns cost a
handful of rows rather than a thousand — the store has a 4 MiB ceiling, and history is pruned at 90
days. It also takes a reading of the rate-limit windows after each turn, so a report never has to
wait for an API call to tell you where you stand.

Subagent turns are recorded too: their tokens are real and come out of the same window.

**The cache hit rate** is in there because almost nothing surfaces it, and a cache that has quietly
stopped working is expensive and invisible. If that percentage falls off a cliff, something in your
prompt prefix started changing between turns.

---

## Commands

| Command | What it does |
|---|---|
| `/runway` | the window, and what has gone into it (~120–170 tokens in `loud`) |
| `/runway today` · `week` · `month` · `all` | report one span |
| `/runway default <span>` | which span a bare `/runway` reports |
| `/runway quiet` | report into a pane: no tokens, terminal only |
| `/runway loud` | report into the transcript: every surface, a few tokens |
| `/runway reset` | forget the ledger |
| `/runway help` | the list above |

### loud and quiet

This is a real choice, not a preference, and it is worth understanding before you pick.

**`loud`** (the default) answers the command with a transcript row. Every surface draws one —
including the Claude desktop app, which draws no plugin UI at all — so this is the only way the
report is visible everywhere.

It costs tokens, and it is worth being precise about how many. A report is around 430 characters
over 15 lines, so roughly **120–170 tokens**. And a transcript row is not a one-off: once it is
there, it stays in the conversation and is re-read on every later turn of that session. Prompt
caching makes the repeats cheap, but not free. A few `/runway` calls a day disappear into the noise;
one after every turn would not.

**`quiet`** puts the report in a pane instead. That costs nothing at all — nothing enters the
transcript and the model never sees it — and only the terminal draws a pane.

**Recording is free either way**, on every surface, in both modes. Only the report has a price, only
when you ask for one. Which is the honest shape for a tool that measures token spend: the measuring
costs nothing, and showing you the answer costs a little.

---

## Requirements

- **Claude Code 2.1.269 or newer**, with function hooks turned on — they are early access and off by
  default:

  ```json
  { "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
  ```

  in `~/.claude/settings.json`, then quit Claude completely and reopen it. Hook modules load when a
  session starts.

- **A terminal, for `quiet`.** The desktop app records everything but draws no pane, so `quiet`
  reports are invisible there. `loud` works on every surface.

## Install

```bash
claude plugin marketplace add mtalhasahin/claude-runway
claude plugin install runway@runway
```

Or from a clone, which reloads the module when you save a file:

```bash
claude --plugin-dir /path/to/claude-runway
```

---

## What it touches

```bash
claude plugin validate .claude-plugin/plugin.json
```

reports:

```
hooks: session.start, turn.complete, command.run{command=runway},
       ui.render{component=Pane}, ui.close{id=runway}
calls: $.clock.now, $.command.register, $.session.root, $.session.usage,
       $.store.get, $.store.set, $.ui.close, $.ui.invalidate, $.ui.open,
       $.ui.resolve, $.ui.toast
```

No `fs`, no `http`, no `process`, no `model`, no `agent`, no `tool`, no `mcp`, no `prompt`. It reads
no files, makes no network calls, and starts no processes; the prices are a constant in the source.
The scan is mechanical — a hooks module that reaches `$` dynamically fails to load — so the list
cannot be evaded.

It also never registers `prompt.context`, `prompt.section`, `attribution.text`, `skill.prompt` or
`tool.describe`, each of which returns text the model reads, and it passes `turn.complete` through
verbatim rather than appending its own.

---

## How it is put together

```
hooks/
├── hooks.json
├── register.tsx        the only hooks module — a thin shell
└── core/
    ├── pricing.ts      model → rates, and what tokens are worth   [PURE]
    ├── ledger.ts       buckets, spans, grouping, pruning          [PURE]
    ├── format.ts       the report, as lines of text               [PURE]
    └── command.ts      /runway parsing and config                 [PURE]
```

**`[PURE]` means no engine, no surface, no `$`** — data in, data out, and that is where the 72 tests
are. The API is early access and says it may change without notice; keeping the rules out of the
shell means a change can only break the shell.

Two shapes in `register.tsx` are forced by the engine's static scan and are worth knowing before you
edit it: every function that takes `$` is declared at the top of the file (the scan follows `$` only
through top-level declarations), and session state is a record passed explicitly rather than a
module-level global, so a reload starts clean.

The report is built as **lines of text**, not a tree, because it has to work in two places that have
nothing in common: a `Pane` in the terminal, and a `command.run` answer on a surface where the
plugin cannot draw at all. Both take strings.

### Developing

```bash
claude plugin test .                                # 72 tests, no network, no fs
claude plugin validate .claude-plugin/plugin.json   # what it hooks and calls
npx -p typescript@5.7 tsc --noEmit                  # types
```

`.claude/types/claude-code.d.ts` is committed on purpose: it pins the build this was written
against. Regenerate it with `/plugin-types .claude/types` after an update.

## Known limits

- **Prices go stale.** They are cached from 2026-06-24 and live in `hooks/core/pricing.ts`. A model
  the table doesn't know is never guessed at — it is reported in tokens, and the day's total is
  marked `+`.
- **The window reading comes from the last API response.** A fresh session shows none until the
  first answer arrives, and says so rather than showing a zero it hasn't earned.
- **The API is early access** and may change between releases without notice.

## License

MIT. See [LICENSE](LICENSE).
