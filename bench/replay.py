#!/usr/bin/env python3
"""Counterfactual replay of a real pi session: what its last N hours would have cost under another folding policy.

    python3 bench/replay.py <hours> <every|none> <density> <session.jsonl>...   (prints one JSON line)

The same work, re-priced: every request keeps its real growth (tokens added since the previous request), its real
output, its real idle gap, and its real cache misses (an expiry, an account switch, a changed system prompt — none
of which depends on the policy). What changes is the size of the context each of those lands on:

  actual    as recorded: compactions, their summarising calls and the rewrite after each.
  policy    resets supplied by an extension (compaction entries an orchestrator wrote from its own record) are kept as they
            happened; model-written compactions are removed; pi-context-stack checkpoints when the tail since the
            last checkpoint reaches `every`: a summary turn that reads the context from cache and writes
            density x span of output, then the next request writes that summary (keep 0%).
            every=none: no folding at all (the context only grows; flagged when it passes the window).

Not modelled: work redone because a summary dropped something (recall exists for that), and the summary turn's
wall time. Prices: Claude Opus 5.5 list, $/M: input 4, output 20, cache read 0.2, cache write 5.
"""
import json, sys, statistics
from datetime import datetime, timezone

IN, OUT, READ, WRITE = 4, 20, 0.2, 5
WINDOW = 1_000_000

def price(inp, out, read, write):
    return (inp * IN + out * OUT + read * READ + write * WRITE) / 1e6

def ts(e):
    t = e.get("timestamp")
    if isinstance(t, str): return datetime.fromisoformat(t.replace("Z", "+00:00")).timestamp()
    m = e.get("message", {}).get("timestamp")
    return m / 1000 if isinstance(m, (int, float)) else None

def load(files, hours):
    evs = []
    for f in files:
        for l in open(f):
            try: e = json.loads(l)
            except Exception: continue
            t = ts(e)
            if t is None: continue
            if e.get("type") == "message" and e["message"].get("role") == "assistant" and e["message"].get("usage"):
                u = e["message"]["usage"]
                if u.get("input", 0) + u.get("cacheRead", 0) + u.get("cacheWrite", 0) == 0: continue
                evs.append((t, "req", u))
            elif e.get("type") == "compaction":
                evs.append((t, "reset" if e.get("fromHook") else "fold", e.get("usage") or {}))
    evs.sort(key=lambda x: x[0])
    if not evs: return []
    cut = evs[-1][0] - hours * 3600
    return [e for e in evs if e[0] >= cut]

def run(evs, every, density):
    reqs = [u for _, k, u in evs if k == "req"]
    ctx = lambda u: u.get("input", 0) + u.get("cacheRead", 0) + u.get("cacheWrite", 0)
    # typical new tokens per normal step, for steps whose real growth is hidden behind a real fold
    steps = [max(0, ctx(b) - ctx(a)) for a, b in zip(reqs, reqs[1:]) if 0 <= ctx(b) - ctx(a) < 50_000]
    typical = statistics.median(steps) if steps else 2000

    # The stable start: what stays cached when everything after it is lost (the system prompt and shared start),
    # read off the real misses. Everything above it at the window's start is foldable tail, not a fixed head.
    misses = [u2.get("cacheRead", 0) for u1, u2 in zip(reqs, reqs[1:]) if u2.get("cacheRead", 0) < 0.6 * ctx(u1)]
    stable = statistics.median([m for m in misses if m > 0]) if any(m > 0 for m in misses) else 20_000

    actual = dict(usd=0.0, folds=0, resets=0, peak=0)
    pol = dict(usd=0.0, checkpoints=0, peak=0, over_window=False)
    prev = None; prev_t = None; since = None  # since = what happened between prev and this request
    base = stack = tail = 0; pending_write = 0
    for t, kind, u in evs:
        if kind in ("fold", "reset"):
            actual["usd"] += price(u.get("input", 0), u.get("output", 0), u.get("cacheRead", 0), u.get("cacheWrite", 0))
            actual["folds" if kind == "fold" else "resets"] += 1
            since = kind
            continue
        c = ctx(u); r, w, i, o = u.get("cacheRead", 0), u.get("cacheWrite", 0), u.get("input", 0), u.get("output", 0)
        actual["usd"] += price(i, o, r, w); actual["peak"] = max(actual["peak"], c)
        if prev is None:
            base = min(c, stable); stack = 0; tail = c - base
            pol["usd"] += price(i, o, r, w)
        elif since == "reset":                       # record-built reset: kept exactly as it happened
            base, stack, tail = c, 0, 0
            pol["usd"] += price(i, o, r, w)
        else:
            g = typical if since == "fold" else max(0, c - ctx(prev))
            tail += g
            P = base + stack + tail
            # a real cache miss (not caused by a fold) hits the policy too, on the policy's context
            miss = since is None and r < 0.6 * ctx(prev)
            if miss:
                kept = min(r, P); write = P - kept; read = kept
            else:
                write = min(P, (g if since == "fold" else w) + pending_write); read = P - write
            pending_write = 0
            pol["usd"] += price(i, o, read, write)
            pol["peak"] = max(pol["peak"], P)
            if P > WINDOW: pol["over_window"] = True
            if every and tail >= every:              # checkpoint: a summary turn on the cached context
                s = max(200, int(density * tail))
                pol["usd"] += price(0, s, P, 400)    # reads P from cache, writes the request prompt, outputs s
                stack += s; tail = 0; pending_write = s
                pol["checkpoints"] += 1
        prev, prev_t, since = u, t, None
    return actual, pol

if __name__ == "__main__":
    hours, every, density = float(sys.argv[1]), sys.argv[2], float(sys.argv[3])
    e = None if every == "none" else int(float(every.rstrip("k")) * (1000 if every.endswith("k") else 1))
    evs = load(sys.argv[4:], hours)
    a, p = run(evs, e, density)
    print(json.dumps({"requests": sum(1 for x in evs if x[1] == "req"), "actual": {k: round(v, 2) if isinstance(v, float) else v for k, v in a.items()},
                      "policy": {k: round(v, 2) if isinstance(v, float) else v for k, v in p.items()}}))
