#!/usr/bin/env node
// Drive pi-context-stack in any running pi session that has the extension loaded.
//
//   pi-context-stack list
//   pi-context-stack status|checkpoint|enable|disable  <target>... [--max-idle <sec>] [--anchor "<text>"]
//   pi-context-stack every <10%|100k|off> <target>...    checkpoint at this much growth (share of the window, or tokens)
//   pi-context-stack keep <20%> <target>...              newest share of the tail kept verbatim at a checkpoint
//   pi-context-stack density <5%> <target>...            summary length as a share of the span it replaces
//   pi-context-stack rewind <k|last> <target>...         back to checkpoint k: task + S1..Sk, the rest leaves the branch
//   pi-context-stack warm <minutes|off> <target>...
//
// <target>: all | pid | session-id prefix | tmux pane (%12) | tmux target (main:5, $2:5, s2w5) | cwd path
// checkpoint --max-idle 270: refuse when the session has been idle longer (its prompt cache is likely cold,
// so the summary turn would pay a full re-read instead of a 0.1x cached one).
import { connect } from "node:net";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const dir = process.env.PI_CONTEXT_STACK_DIR ?? join(homedir(), ".pi", "context-stack");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

function sessions() {
  let names = [];
  try { names = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return []; }
  const out = [];
  for (const f of names) {
    try {
      const s = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (alive(s.pid)) out.push(s);
      else { rmSync(join(dir, f), { force: true }); rmSync(s.socket, { force: true }); }
    } catch {}
  }
  return out.sort((a, b) => a.pid - b.pid);
}

const ask = (s, req) => new Promise((ok) => {
  const c = connect(s.socket);
  let buf = "";
  const t = setTimeout(() => { c.destroy(); ok({ ok: false, error: "no answer within 3s" }); }, 3000);
  c.on("connect", () => c.write(JSON.stringify(req) + "\n"));
  c.on("data", (d) => (buf += d));
  c.on("end", () => { clearTimeout(t); try { ok(JSON.parse(buf)); } catch { ok({ ok: false, error: "bad answer" }); } });
  c.on("error", (e) => { clearTimeout(t); ok({ ok: false, error: e.code ?? e.message }); });
});

const tmux = (fmt, target, server) => {
  try { return execFileSync("tmux", [...(server ? ["-S", server] : []), "display-message", "-p", ...(target ? ["-t", target] : []), fmt], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
};
// The session's own tmux server ($TMUX = socket,pid,session), not necessarily the one this CLI runs under.
const where = (s) => (s.tmuxPane ? tmux("#{session_name}:#{window_index}", s.tmuxPane, s.tmux?.split(",")[0]) ?? s.tmuxPane : "-");

// Pane ids are per tmux server: only match sessions on the server this CLI talks to.
const myServer = process.env.TMUX?.split(",")[0] ?? `${process.env.TMUX_TMPDIR ?? "/tmp"}/tmux-${process.getuid()}/default`;
const onMyServer = (s) => s.tmux?.split(",")[0] === myServer;

function pick(all, target) {
  if (target === "all") return all;
  if (/^\d+$/.test(target)) return all.filter((s) => s.pid === Number(target));
  if (target.startsWith("%")) return all.filter((s) => onMyServer(s) && s.tmuxPane === target);
  const sw = target.match(/^s(\d+)w(\d+)$/); // shorthand: tmux session $2, window 5
  if (sw || target.includes(":")) {
    const pane = tmux("#{pane_id}", sw ? `$${sw[1]}:${sw[2]}` : target);
    return pane ? all.filter((s) => onMyServer(s) && s.tmuxPane === pane) : [];
  }
  const byId = all.filter((s) => s.sessionId?.startsWith(target));
  if (byId.length) return byId;
  const p = resolve(target);
  return all.filter((s) => s.cwd === p);
}

const fmt = (st) => {
  const k = (n) => (n == null ? "-" : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const pct = (v) => `${+(v * 100).toFixed(2)}%`;
  const every = typeof st.every === "string" ? `${st.every}=${k(st.everyTokens)}` : k(st.every);
  return `${st.enabled ? "on " : "off"}  every ${every.padEnd(9)} keep ${pct(st.keep).padEnd(4)} density ${pct(st.density).padEnd(4)} tail ${k(st.liveTail).padEnd(5)} cps ${String(st.checkpoints).padEnd(3)} stack ${k(st.stackTokens).padEnd(5)} ${st.pending.padEnd(6)} ${st.idle ? `idle ${st.idleSec ?? "-"}s` : "running"}`;
};

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(`--${name}`); return i < 0 ? undefined : argv.splice(i, 2)[1]; };
const maxIdle = flag("max-idle");
const anchor = flag("anchor");
const [op, ...rest] = argv;
const all = sessions();

if (!op || op === "help" || op === "--help") {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 15).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(op ? 0 : 1);
}

if (op === "list") {
  if (!all.length) { console.log(`no pi sessions with pi-context-stack (${dir})`); process.exit(0); }
  for (const s of all) {
    const r = await ask(s, { op: "status" });
    console.log(`${String(s.pid).padEnd(8)} ${(s.sessionId ?? "-").slice(0, 8)}  ${where(s).padEnd(28)} ${r.ok ? fmt(r.status) : "! " + r.error}  ${s.cwd}`);
  }
  process.exit(0);
}

const ops = { status: 0, checkpoint: 0, enable: 0, disable: 0, every: 1, keep: 1, density: 1, warm: 1, rewind: 1 };
if (!(op in ops)) { console.error(`unknown command "${op}" (try: help)`); process.exit(2); }
const value = ops[op] ? rest.shift() : undefined;
if (ops[op] && value === undefined) { console.error(`${op} needs a value`); process.exit(2); }
if (!rest.length) { console.error("name at least one target (or all); see: pi-context-stack list"); process.exit(2); }

const req = { op };
if (op === "every" || op === "keep" || op === "density") req.value = value;
if (op === "warm") req.minutes = value === "off" ? 0 : Number(value);
if (op === "rewind") req.checkpoint = value;
if (maxIdle !== undefined) req.maxIdleSec = Number(maxIdle);
if (anchor !== undefined) req.anchor = anchor;

let failed = 0;
for (const t of rest) {
  const hits = pick(all, t);
  if (!hits.length) { console.error(`${t}: no matching session`); failed++; continue; }
  for (const s of hits) {
    const r = await ask(s, req);
    console.log(`${String(s.pid).padEnd(8)} ${where(s).padEnd(28)} ${r.ok ? fmt(r.status) : "! " + r.error}`);
    if (!r.ok) failed++;
  }
}
process.exit(failed ? 1 : 0);
