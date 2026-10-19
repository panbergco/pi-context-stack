---
name: pi-context-stack
description: Checkpoints instead of compaction for long-running pi sessions — what pi-context-stack does to a session's context, and the pi-context-stack CLI that checkpoints, configures, inspects or rewinds any running session. Use when a session shows "[context-stack checkpoint summary]" messages, when a detail you need was summarised away (read it back with the context_stack_recall tool), when asked to checkpoint, rewind, or change how often a session folds its context, or when wiring a checkpoint to an event such as a finished task.
---

# pi-context-stack

**What it does to a session.** At a checkpoint the model summarises the span since the last checkpoint, as a normal
turn on its cached context. From then on the model sees `[task] [S1] … [Sk] [what came after]`. Summaries are only
ever appended, so the start of every request stays byte-identical and is read from the prompt cache; a checkpoint
writes only its new summary. Nothing is deleted: the session file keeps every message.

**When a summary lacks a detail you need**, do not guess and do not redo the work — call
`context_stack_recall` with `checkpoint: k` (the number in `[context-stack checkpoint summary] k`) and
`match: "<text>"` for only the matching lines (each with the message it came from), or no `match` for the whole
span in slices (`offset`). Omit `checkpoint` and give `match` to search every checkpoint at once. In reference mode
(`density: 0`) checkpoints are indexes, not summaries: recall is how you read what they cover.

## When checkpoints happen

Any of: the live tail reaches `every` · pi's threshold compaction (replaced, if `replaceCompaction`) ·
`/stack checkpoint` · the CLI · `pi.events.emit("context-stack:command", { op: "checkpoint" })`.
A checkpoint taken mid-run resumes the run. Event-driven only (e.g. checkpoint when an orchestrator finishes a
task): `every: off`, `replaceCompaction: false`.

| Setting | Default | |
|---|---|---|
| `enabled` | `true` | |
| `every` | `10%` | growth that triggers one: share of the window, tokens (`100k`), or `off` |
| `keep` | `0%` | newest share of the post-checkpoint tail kept verbatim |
| `density` | `5%` | summary length as a share of the span it replaces; `0` = reference mode (no summary turn) |
| `replaceCompaction` | `true` | take a checkpoint instead of pi's threshold compaction |

Set in `~/.pi/agent/context-stack.json`, `<project>/.pi/context-stack.json`, `PI_CONTEXT_STACK_<NAME>` (upper
snake case), or per session with `/stack every|keep|density …` (saved in the session).

## CLI

`pi-context-stack` (in the package's `bin/`). Targets: `all`, pid, session-id prefix, tmux pane `%12`, tmux window
`main:5` / `s2w5`, or a cwd.

```
pi-context-stack list                              # every session with the extension: settings, tail, checkpoints, idle
pi-context-stack checkpoint <target> --max-idle 270   # refuse when idle > 270 s (cache likely cold)
pi-context-stack every 100k|10%|off <target>       # also: keep 20% · density 5% · enable · disable · status
pi-context-stack rewind last|<k> <target>          # back to checkpoint k: task + S1..Sk; later work leaves the branch
pi-context-stack warm <minutes>|off <target>       # hold the cache warm (inside pi's 30-minute idle cap)
```

Exit code 1 when any target refused (`nothing new since the last checkpoint`, `cache likely cold`, no match).
In a session the same verbs are `/stack …`. Rewinding keeps the later work reachable from `/tree`.
