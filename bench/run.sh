#!/usr/bin/env bash
# Same task, three ways, on a free local model; then the bill each would run up on Anthropic.
#   A: plain pi (no folding)   B: pi compaction at ~8k context   C: pi-context-stack, checkpoint every 6k
#   C<n>: same, keeping the newest n% of each span verbatim (MODES="A B C C50" picks; default shown)
#   R, R<n>: reference mode (density 0): no summary turn, an index of each span pointing at recall
#
#   bench/run.sh <provider/model> [parts]     e.g. a free local model; 12 files by default
#
# The task: read N files one per turn, each holding a secret code, then write every code from memory.
# Codes read before a fold survive only through the summary, so the final file checks recall. The code
# sits at a random line and only read/write are enabled, so every mode does the same work (no grep, no
# partial reads: an earlier version let the model learn to read 5 lines per file after a checkpoint).
# Runs are sequential: the local server has one slot, and parallel runs would evict each other's cache.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
model=${1:?usage: bench/run.sh <provider/model> [parts]}
parts=${2:-12}
questions=${QUESTIONS:-1}      # withheld detail questions, asked after the run
window=${BENCH_WINDOW:-262144} # the model's context window (B's compaction threshold is set from it)
fold_at=${BENCH_FOLD_AT:-8000} # B compacts at about this much context
every=${BENCH_EVERY:-6k}       # C checkpoints at this much growth
out=$here/.scratch/bench/$(date +%Y%m%d-%H%M%S)
mkdir -p "$out" && printf '*\n' > "$here/.scratch/.gitignore"

python3 - "$out/tpl" "$parts" "$questions" <<'PY'
import os, random, sys
d, n, nq = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]); os.makedirs(d); random.seed(11)
w = "river copper lantern orchard falcon granite meadow harbor ember willow quartz saffron".split()
ans, files = [], []
for i in range(1, n + 1):
    code = f"{random.choice(w).upper()}-{random.randint(100, 999)}"; ans.append(f"part{i} {code}")
    body = [f"Line {j}: the {random.choice(w)} report notes {random.randint(1, 9999)} units of {random.choice(w)} near {random.choice(w)} station." for j in range(120)]
    body.insert(random.randint(20, 119), f"SECRET CODE FOR PART {i}: {code}")  # anywhere: a partial read can miss it
    open(f"{d}/part{i}.txt", "w").write(f"# Part {i}\n\n" + "\n".join(body) + "\n")
    files.append(body)
# Withheld questions: a line-level detail from files spread across the whole run (q1 = part 2, line 7).
picks = [(2, 7)] + [(1 + (k * n) // nq + random.randint(0, max(0, n // nq - 1)), random.randint(1, 110)) for k in range(1, nq)]
qs, qa = [], []
for q, (f, line) in enumerate(picks[:nq], 1):
    text = next(l for l in files[f - 1] if l.startswith(f"Line {line}:"))
    qs.append(f"q{q}: in part{f}.txt, on the line that starts with 'Line {line}:', what is the word right before 'station'?")
    qa.append(f"q{q} " + text.split(" near ")[1].split(" station")[0])
open(f"{d}/../answers.txt", "w").write("\n".join(ans) + "\n")
open(f"{d}/../qa.txt", "w").write("\n".join(qa) + "\n")
open(f"{d}/../questions.txt", "w").write(" ".join(qs))
PY

task="Each file holds one SECRET CODE line somewhere in it. Read part1.txt through part${parts}.txt in numeric order, exactly one read call per turn (never two files in one turn). After each read, state in one line the part number and its SECRET CODE. When all ${parts} are read, write all ${parts} codes to codes.md (one per line, \"partN CODE\") WITHOUT re-reading any file. Then reply DONE."
# Withheld until the run is over: a detail no summary had a reason to keep.
followup="Answer these without reading any part*.txt file from disk again (any other tool you have is fine). $(cat "$out/questions.txt") Write one line per question to detail.txt, as \"qN WORD\" (WORD = UNKNOWN if you cannot tell), then reply DONE."

# BENCH_EXTENSIONS: extra extensions for every mode, colon-separated (e.g. the Anthropic OAuth shaping one).
extra=(); IFS=: read -ra _ext <<< "${BENCH_EXTENSIONS:-}"; for e in "${_ext[@]}"; do [ -n "$e" ] && extra+=(-e "$e"); done

run() { # mode, extra pi args...
  local m=$1; shift
  cp -r "$out/tpl" "$out/w$m"; mkdir -p "$out/s$m"
  # B: make pi compact at ~fold_at of context and keep ~2k recent
  [ "$m" = B ] && mkdir -p "$out/wB/.pi" && printf '{ "compaction": { "enabled": true, "reserveTokens": %s, "keepRecentTokens": 2000 } }\n' $((window - fold_at)) > "$out/wB/.pi/settings.json"
  ( cd "$out/w$m" && PI_BENCH_REQLOG=$out/req$m.jsonl PI_CONTEXT_STACK_DIR=$out/ctl \
      timeout 1800 pi -ne -ns -np -nc --offline --session-dir "$out/s$m" --model "$model" --thinking off --tools read,write,context_stack_recall \
      "${extra[@]}" "$@" -e "$here/bench/log-requests.ts" -p "$task" > "$out/out$m.txt" 2>&1 ) || echo "mode $m exited $?"
  ( cd "$out/w$m" && PI_BENCH_REQLOG=$out/req$m.jsonl PI_CONTEXT_STACK_DIR=$out/ctl \
      timeout 900 pi -ne -ns -np -nc --offline --session-dir "$out/s$m" --session "$(ls "$out"/s$m/*.jsonl)" --model "$model" --thinking off --tools read,write,context_stack_recall \
      "${extra[@]}" "$@" -e "$here/bench/log-requests.ts" -p "$followup" >> "$out/out$m.txt" 2>&1 ) || echo "mode $m follow-up exited $?"
  local ok; ok=$(comm -12 <(sort "$out/w$m/codes.md" 2>/dev/null) <(sort "$out/answers.txt") | wc -l)
  local d; d=$(comm -12 <(tr 'A-Z' 'a-z' < "$out/w$m/detail.txt" 2>/dev/null | sed 's/[^a-z0-9 ]//g' | sort) <(tr 'A-Z' 'a-z' < "$out/qa.txt" | sort) | wc -l)
  local calls; calls=$(node -e 'const n={};for(const l of require("fs").readFileSync(process.argv[1],"utf8").split("\n")){if(!l)continue;const e=JSON.parse(l);if(e.type==="message"&&e.message.role==="assistant")for(const c of e.message.content)if(c.type==="toolCall")n[c.name]=(n[c.name]||0)+1}console.log(Object.entries(n).map(([k,v])=>k.replace("context_stack_","")+"="+v).join(","))' "$(ls "$out"/s$m/*.jsonl)")
  printf '%-4s codes %s/%s  withheld %s/%s  tools %-28s ' "$m" "$ok" "$parts" "${d:-0}" "$questions" "$calls"
  # The logger loads last, so it records the request as finally sent (after context-stack's breakpoint).
  if grep -q '"system":\[' "$out/req$m.jsonl" 2>/dev/null; then node "$here/bench/cost.mjs" "$out"/s$m/*.jsonl ${BENCH_PRICE:+--price "$BENCH_PRICE"} | tail -1  # real provider: its own counts
  else node "$here/bench/anthropic-sim.mjs" "$out/req$m.jsonl" "$out"/s$m/*.jsonl; fi
}

modes=${MODES:-A B C C50}
for m in $modes; do case $m in
  A|B) run "$m" ;;
  C)   run C -e "$here/src/extension.ts" --context-stack-every "$every" ;;
  C*)  PI_CONTEXT_STACK_KEEP=${m#C}% run "$m" -e "$here/src/extension.ts" --context-stack-every "$every" ;;
  R)   PI_CONTEXT_STACK_DENSITY=0 run R -e "$here/src/extension.ts" --context-stack-every "$every" ;;
  R*)  PI_CONTEXT_STACK_DENSITY=0 PI_CONTEXT_STACK_KEEP=${m#R}% run "$m" -e "$here/src/extension.ts" --context-stack-every "$every" ;;
esac; done
echo "artifacts: $out"
