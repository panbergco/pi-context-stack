#!/usr/bin/env node
// What a run would have cost on Anthropic, replayed from the exact request payloads (bench/log-requests.ts).
//
//   node bench/anthropic-sim.mjs <reqlog.jsonl> <session.jsonl> [--price in,out,cacheRead,cacheWrite]
//
// Why a simulation: the local model's cache (llama.cpp, hybrid Qwen) only resumes at its own saved
// positions, so its cache numbers say nothing about Anthropic's. Anthropic's rules, as pi drives them:
//   - breakpoints at the end of the tools, the system prompt and the last message (if user/tool result);
//   - a request reads the longest earlier-written breakpoint prefix that it shares, looking back <= 20
//     blocks from each of its own breakpoints; it writes everything from there to its last breakpoint;
//   - entries are written only at breakpoints. (5-minute expiry ignored: these runs have no long gaps.)
// Tokens per block: chars, scaled per request to the prompt size the provider actually reported.
// Requests not in the log (pi's compaction summary call) are billed from their recorded usage as
// uncached writes: their prefix is unique to them.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const pi = args.indexOf("--price");
const [pIn, pOut, pRead, pWrite] = pi < 0 ? [5, 25, 0.5, 6.25] : args.splice(pi, 2)[1].split(",").map(Number);
const [reqFile, sessFile] = args;
const lines = (f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

const reqs = lines(reqFile).map((r) => r.payload);
if (reqs.some((p) => Array.isArray(p?.system))) {
  console.error("Anthropic-format requests: the provider reported its real cache reads and writes; use bench/cost.mjs on the session.");
  process.exit(2);
}
const usages = [];      // assistant usage, in request order
const compactions = []; // pi compaction calls (not logged)
for (const e of lines(sessFile)) {
  if (e.type === "message" && e.message?.role === "assistant" && e.message.usage) usages.push(e.message.usage);
  if (e.type === "compaction" && e.usage) compactions.push(e.usage);
}

/** Request -> ordered blocks + breakpoint indices, mirroring pi's anthropic-messages placement. */
function blocksOf(p) {
  const b = [];
  const bp = [];
  if (p.tools?.length) { b.push(JSON.stringify(p.tools)); bp.push(b.length - 1); }
  const msgs = p.messages ?? [];
  let i = 0;
  for (; i < msgs.length && (msgs[i].role === "system" || msgs[i].role === "developer"); i++) b.push(JSON.stringify(msgs[i].content));
  if (i > 0) bp.push(b.length - 1);
  for (; i < msgs.length; i++) {
    const m = msgs[i];
    const parts = Array.isArray(m.content) ? m.content : m.content == null ? [] : [m.content];
    for (const c of parts) b.push(m.role + JSON.stringify(c));
    if (m.tool_calls) b.push(m.role + JSON.stringify(m.tool_calls));
    if (!parts.length && !m.tool_calls) b.push(m.role);
  }
  const last = msgs.at(-1);
  if (last && (last.role === "user" || last.role === "tool")) bp.push(b.length - 1);
  // pi-context-stack's own breakpoint on the newest summary (placeSummaryBreakpoint), when there is one.
  let newest = -1;
  b.forEach((x, i) => { if (i > (bp[1] ?? bp[0] ?? -1) && x.includes("[context-stack checkpoint summary]")) newest = i; });
  if (newest >= 0 && !bp.includes(newest)) bp.push(newest);
  return { b, bp };
}

const cache = new Set();
const t = { requests: 0, read: 0, write: 0, uncachedTail: 0, output: 0 };
const per = [];
reqs.forEach((p, n) => {
  const { b, bp } = blocksOf(p);
  const hashes = [];
  let h = createHash("sha256");
  for (const x of b) { h.update(x); hashes.push(h.copy().digest("hex")); }
  const chars = b.map((x) => x.length);
  const u = usages[n];
  if (u && !u.input && !u.output && !u.cacheRead && !u.cacheWrite) return; // failed request: not billed
  const reported = u ? (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) : 0;
  const total = chars.reduce((a, c) => a + c, 0);
  const scale = reported ? reported / total : 0.25;
  const tok = (from, to) => { let s = 0; for (let i = from; i < to; i++) s += chars[i]; return s * scale; }; // [from, to)
  let hit = -1;
  for (const p0 of bp) for (let i = p0; i >= Math.max(0, p0 - 20); i--) if (cache.has(hashes[i])) { hit = Math.max(hit, i); break; }
  const lastBp = bp.length ? Math.max(...bp) : -1;
  const read = tok(0, hit + 1);
  const write = lastBp > hit ? tok(hit + 1, lastBp + 1) : 0;
  const tail = tok(Math.max(hit, lastBp) + 1, b.length);
  for (const p0 of bp) cache.add(hashes[p0]);
  t.requests++; t.read += read; t.write += write; t.uncachedTail += tail; t.output += u?.output ?? 0;
  per.push({ n, blocks: b.length, read: Math.round(read), write: Math.round(write) });
});
for (const c of compactions) { t.requests++; t.write += (c.input ?? 0) + (c.cacheRead ?? 0) + (c.cacheWrite ?? 0); t.output += c.output ?? 0; }

const usd = (t.read * pRead + t.write * pWrite + t.uncachedTail * pIn + t.output * pOut) / 1e6;
if (usages.length !== reqs.length) console.error(`! ${reqs.length} logged requests vs ${usages.length} assistant replies: scaling is approximate`);
if (process.argv.includes("--per")) for (const r of per) console.error(`  #${r.n} blocks ${r.blocks} read ${r.read} write ${r.write}`);
console.log(JSON.stringify({ requests: t.requests, compactionCalls: compactions.length, read: Math.round(t.read), write: Math.round(t.write), uncached: Math.round(t.uncachedTail), output: t.output, usd: +usd.toFixed(4) }));
