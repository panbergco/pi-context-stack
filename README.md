# pi-context-stack

Checkpoints instead of compaction, for pi: a session (an autonomous agent, say) runs for a long time without hitting the context limit, without losing anything, and with the prompt cache intact.

```
[system + tools] [task] [S1] [S2] … [Sk] [kept: newest share of the last span, verbatim] [everything since]
 └──────── byte-identical, read from cache ────────┘
```

- **A checkpoint is a normal turn.** The model writes the summary on its own *cached* context (read at 0.1×), instead of compaction's separate, uncached summarisation request.
- **Summaries are stacked, never refolded.** Each covers only the span since the previous checkpoint; S1 is never compressed again.
- **Reference mode: effectively unbounded history.** With `density: 0` a checkpoint costs no model turn and about 200 tokens of stack, so a 1M window holds thousands of them; the base context pi loads is the fixed start, and every span stays one recall away. The request being worked on, and the newest step's results, are never folded.
- **Lossless.** Nothing leaves the session file. The `context_stack_recall` tool hands the model any summary's originals back verbatim, in slices, as an ordinary appended tool result.
- **Only the new summary is a cache write.** The request after checkpoint k reads `[task..S(k-1)]` from cache and writes `Sk` (plus whatever `keep` retains). On Anthropic the extension puts a cache breakpoint on the newest summary (pi uses the other three/four).
- **It drives itself.** On by default: a checkpoint every 10% of the context window, and in place of pi's threshold compaction. A checkpoint taken mid-run resumes the run.
- **And it is driven from outside**: `/stack`, the `pi-context-stack` CLI (any running session, over a local socket), or `pi.events` from another extension.

A short skill (`skills/pi-context-stack/SKILL.md`) ships with it: what the extension does to a session, recall, and the CLI.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Project the context and replace threshold compaction. |
| `every` | `10%` | Checkpoint when the live tail reaches this: a share of the model's window (`10%`) or tokens (`100k`), or `off` (then only on demand and at pi's threshold). |
| `keep` | `0%` | Newest share of the tail since the last checkpoint kept verbatim at each checkpoint (up to 90%). Counted only from after the last checkpoint, never the task or the summaries. The kept part never starts on a tool result. |
| `density` | `5%` | Target summary length as a share of the span it replaces: 5% of a 100k span asks for about 5k tokens. `0` (or `reference`) is **reference mode**: no summary turn at all; each checkpoint is a deterministic index of its span (size, time, files read and written, commands, the last thing said) pointing at recall. |
| `replaceCompaction` | `true` | Take a checkpoint instead of pi's threshold compaction. `false` leaves compaction to pi (or to another extension that manages it). With `every: off` too, checkpoints happen only when asked: event-driven, e.g. when an orchestrator finishes a task. |

Later wins: defaults · `~/.pi/agent/context-stack.json` · `<project>/.pi/context-stack.json` · `PI_CONTEXT_STACK_ENABLED|EVERY|KEEP|DENSITY|REPLACE_COMPACTION` · `--context-stack` / `--context-stack-every` · this session's `/stack` or CLI change (saved in the session, so it survives a resume).

```json
{ "every": "100k", "keep": "10%", "density": "5%" }
```

## Install

```bash
pi install git:github.com/panbergco/pi-context-stack        # every session (add -l for this project only)
```

Then `/reload` (or restart) the sessions that should have it. It needs no npm dependencies: pi supplies the one it imports. For one session only: `pi -e ./src/extension.ts` from a clone.

The CLI ships in the same checkout:

```bash
ln -s ~/.pi/agent/git/github.com/panbergco/pi-context-stack/bin/pi-context-stack.mjs ~/.local/bin/pi-context-stack
```

## Operate

| In a session | |
|---|---|
| `/stack status` | Settings, live tail, checkpoints, stack size. |
| `/stack checkpoint` | Now (idle) or at the next turn boundary (running). |
| `/stack every 10%` · `keep 20%` · `density 5%` | Change for this session. |
| `/stack on [--anchor "<text>"]` / `off` | Keep everything up to that user exchange verbatim instead of only the task / restore the full history. |
| `/stack rewind [k\|last]` | Back to checkpoint k as it was taken: task + S1..Sk (+ what it kept). Later work leaves the branch but stays in the session file (`/tree` reaches it). |
| `/stack rewind --anchor "<text>" [--slice f.md]` · `slice --anchor "<text>" f.md` | Branch back to a user exchange / dump what came after it. |
| `/stack warm <min>` | Hold the cache warm (inside pi's 30-minute idle cap). |

```
pi-context-stack list                                   # every running session with the extension
pi-context-stack checkpoint main:5 --max-idle 270       # refuse if idle > 270 s (cache likely cold)
pi-context-stack every 100k all                         # also: keep, density, enable, disable, warm, status
pi-context-stack rewind last s2w5                       # back to the newest checkpoint
```

Targets: `all`, a pid, a session-id prefix, a tmux pane (`%12`), a tmux window (`main:5`, `$2:5`, `s2w5`), or a cwd.

From another extension:

```ts
pi.events.emit("context-stack:command", { op: "checkpoint" });            // or enable/disable/status
pi.events.emit("context-stack:command", { op: "every", value: "100k" });  // keep, density likewise
pi.events.emit("context-stack:command", { op: "warm", minutes: 20 });
pi.events.on("context-stack:status", (s) => { /* enabled, every, keep, density, liveTail, checkpoints, stackTokens, pending … */ });
```

Overflow recovery and manual `/compact` stay pi's.

## Measured (2026-10-18)

**On Anthropic, Sonnet 5.5** (subscription OAuth, provider-reported usage, list prices $2 / $10 / $0.10 / $2.50 per M). 30 files of ~3.3k tokens, one per turn; then 8 withheld questions about single lines in files spread across the run, answered without reading any file again. B compacts at ~30k of context, C checkpoints every 25k.

| Mode | Codes | Withheld | Peak context | Requests | Cost |
|---|---|---|---|---|---|
| A: plain pi, no folding | 30/30 | 8/8 | 100.7k | 34 | $0.454 |
| B: pi compaction | 28/30, re-read 2 files | 1/8 (chance is ~1/12 per question) | 30.9k | 37 (3 summary calls) | $0.426 |
| C: pi-context-stack | 30/30 | 8/8, 6 targeted recalls (`match`) | 39.8k | 39 (3 checkpoints) | $0.436 |

C answers like A at the cost of B, with the context held at 40% of A's. Summaries came out at 2.1–3.3% of their span against a 5% target (the model writes shorter than asked). Variance seen: with the follow-up worded "answer from what you know", the model declined to recall (2/8); with whole-span recalls (before `match`) one run paid $0.18 for 71k tokens of recall. A grows without bound: its cache reads scale with the square of the run length (one more file re-reads everything before it), C's with its length.

Reference mode on the same task (no summary turns): 30/30 codes, 8/8 withheld, **$0.394** with 0% kept, $0.404 with 20% kept. Two fixes came from its first runs: the active request is kept verbatim after the stack (a cut had folded the question away), and reference mode keeps the newest step (it had folded six fresh recall results, which were then fetched again).

**On a free local model** (earlier, 12 files):

`bench/run.sh`: one task, run every way on a free local model (Qwen3.8 27B on llama.cpp). It reads 12 files one per turn, each hiding a code at a random line, and writes all 12 codes from memory. Then a question it was **not** told about in advance: a detail from line 7 of file 2, to be answered without re-reading. Cost: the logged requests replayed under Anthropic's caching rules at Opus 4.5 list prices (`bench/anthropic-sim.mjs`). The local server's cache figures are not used: llama.cpp resumes a hybrid Qwen only at its own saved positions.

| Mode | Codes | Withheld detail | Requests | Output tok | Anthropic $ |
|---|---|---|---|---|---|
| A: plain pi, no folding | 12/12 | ✅ | 16 | 1.3k | 0.42 |
| B: pi compaction at ~8k | 12/12 | ❌ lost | 21 (6 summary calls) | 14.7k | 0.74 |
| C: stack, every 6k | 12/12 | ✅ via recall | 22 (5 checkpoints) | 8.1k | 0.55 |
| C50: same, keep 50% | 12/12 | ✅ via recall | 23 (6 checkpoints) | 9.9k | 0.74 |

- Summaries landed at 4.6–9% of their span against a 5% target.
- After each checkpoint the task and all earlier summaries came from cache; only the new summary (and the kept part) was written.
- A is cheapest only while everything fits. It grows without bound; B and C are what a long-running session chooses between.
- Output tokens include the local model's reasoning, which inflates B and C alike.

**Proven on Anthropic** (Sonnet 5.5, subscription OAuth, 6 files, provider-reported usage): the first request after checkpoint k read `[system..S(k-1)]` from cache and wrote only `Sk` plus the kept part. With keep 0: reads 1,829 → 2,498 (= 1,829 + S1), writes 669 → 725 (S1, then S2). With keep 50%, where the request no longer ends at the summary: reads 1,830 → 2,426 → 3,092, held by the extension's breakpoint on the newest summary (3 of pi's + 1 = Anthropic's limit of 4). 6/6 codes and the withheld detail (via recall) in both modes.

## Limits

- **Cache costs for the local-model runs are simulated** from the exact requests under Anthropic's breakpoint rules, ignoring the 5-minute expiry; the Anthropic run above is the measured check of those rules.
- **Summaries are model-written**, as a dedicated turn with a length target; the originals are always one recall away. The benchmark above is narrow: one task, one model, one run per mode.
- **The stack grows linearly** (a few hundred summaries fit a 1M window at 100k/5%). Folding the oldest summaries together is not built.
- **pi caps idle warming at 30 minutes**; `warm` only overrides pi's per-refresh decision inside that cap.
- The projection finds an explicit anchor by timestamp; if it cannot, it **fails open** and sends the full context.
- `rewind` needs a command context, so it is a `/stack` command only.

## Test

`npm test` (Node ≥ 22.6): projection, cut, recall, settings layering, the breakpoint placement, the event wiring, and the CLI over a real socket. `bench/run.sh [model] [parts]` with `MODES="A B C C50"` reruns the comparison.

