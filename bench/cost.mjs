#!/usr/bin/env node
// Token bill of pi session files: every model request, including compaction's own summary call.
//
//   node bench/cost.mjs <session.jsonl>...      [--price in,out,cacheRead,cacheWrite]  ($/M tokens)
//
// Default price: Claude Opus 4.5 list ($5 / $25 / $0.50 / $6.25 for 5-min cache writes).
// "fresh" = prompt tokens not read from cache. On a provider with explicit caching (Anthropic) pi writes
// them to the cache, so they are priced as cache writes; local llama.cpp reports them as plain input.
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const args = process.argv.slice(2);
const pi = args.indexOf("--price");
const [pIn, pOut, pRead, pWrite] = pi < 0 ? [5, 25, 0.5, 6.25] : args.splice(pi, 2)[1].split(",").map(Number);

const rows = [];
for (const file of args) {
  const t = { file: basename(file), requests: 0, summaryCalls: 0, fresh: 0, cacheRead: 0, output: 0, peak: 0 };
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    const e = JSON.parse(line);
    const u = e.type === "message" && e.message?.role === "assistant" ? e.message.usage : e.type === "compaction" ? e.usage : null;
    if (!u) continue;
    t.requests++;
    if (e.type === "compaction") t.summaryCalls++;
    t.fresh += (u.input ?? 0) + (u.cacheWrite ?? 0);
    t.cacheRead += u.cacheRead ?? 0;
    t.output += u.output ?? 0;
    t.peak = Math.max(t.peak, (u.input ?? 0) + (u.cacheWrite ?? 0) + (u.cacheRead ?? 0));
  }
  t.usd = (t.fresh * pWrite + t.cacheRead * pRead + t.output * pOut) / 1e6;
  t.usdNoCache = ((t.fresh + t.cacheRead) * pIn + t.output * pOut) / 1e6;
  rows.push(t);
}
const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
console.log("session                                    req  summ   fresh   cached   output   peak     $cached   $if-no-cache");
for (const t of rows) {
  console.log(`${t.file.slice(-42).padEnd(42)} ${String(t.requests).padStart(4)} ${String(t.summaryCalls).padStart(5)} ${k(t.fresh).padStart(7)} ${k(t.cacheRead).padStart(8)} ${k(t.output).padStart(8)} ${k(t.peak).padStart(6)}   ${t.usd.toFixed(4).padStart(8)}   ${t.usdNoCache.toFixed(4).padStart(8)}`);
}
