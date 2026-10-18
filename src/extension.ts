// pi-context-stack: checkpoints instead of compaction, so a session can run for a long time.
//
//   - A checkpoint asks the model, as a normal turn on its CACHED context, to summarise the span since the
//     last checkpoint (minus the newest `keep` share, which stays verbatim), at `density` of its size.
//   - The live context is projected: [task/head] + [S1..Sk] + [kept + everything since].
//     The head and the summaries never change, so the provider keeps reading them from cache.
//   - Summaries are stacked, never refolded. Lossless: every summary's originals stay in the session file
//     and the model reads them back verbatim with the context_stack_recall tool.
//   - A checkpoint taken mid-run resumes the run, so an autonomous agent keeps working.
//
// It drives itself (on by default, every 10% of the window) and is also driven from outside:
//   /stack ... · bin/pi-context-stack.mjs over a control socket · pi.events "context-stack:command"
//
// Settings, later wins: defaults · ~/.pi/agent/context-stack.json · <cwd>/.pi/context-stack.json
//   · PI_CONTEXT_STACK_{ENABLED,EVERY,KEEP,DENSITY,REPLACE_COMPACTION} · --context-stack[-every] · this session's /stack or CLI.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  type Checkpoint, type Cut, type MessageLike, type Settings, type StackState,
  DEFAULTS, NUDGE_TYPE, PROMPT_TYPE, RECALL_TOOL, RESUME_LINE, RESUME_TYPE, SUMMARY_MARKER,
  anchorFor, chooseCut, emptyState, estimateTokens, everyTokens, parseEvery, parseShare, placeSummaryBreakpoint,
  project, render, spanOf, summaryPrompt, tailTokens, textOf,
} from "./stack.ts";
import { startControl } from "./control.ts";

const STATE = "context-stack:state";
const CHECKPOINT = "context-stack:checkpoint";
const NUDGE_PROMPT = "[context-stack] A checkpoint interrupted your run just before this. If the task is not complete, continue it now; if it is, reply with your final answer again.";

/** A settings patch from untrusted input (file, env, CLI). Throws on an invalid value, names the key. */
export function parseSettings(raw: Record<string, unknown>): Partial<Settings> {
  const out: Partial<Settings> = {};
  const bool = (v: unknown) => v === true || /^(1|true|on|yes)$/i.test(String(v));
  if (raw.enabled !== undefined && raw.enabled !== "") out.enabled = bool(raw.enabled);
  if (raw.replaceCompaction !== undefined && raw.replaceCompaction !== "") out.replaceCompaction = bool(raw.replaceCompaction);
  if (raw.every !== undefined) {
    const e = parseEvery(raw.every);
    if (e === undefined) throw new Error(`every: want e.g. 10%, 100k, 80000 or off, got "${raw.every}"`);
    out.every = e;
  }
  for (const key of ["keep", "density"] as const) {
    if (raw[key] === undefined) continue;
    const v = parseShare(raw[key]);
    if (v === undefined || (key === "keep" && v > 0.9) || (key === "density" && v === 0)) throw new Error(`${key}: want a share like 20% or 0.2, got "${raw[key]}"`);
    out[key] = v;
  }
  return out;
}

function fileSettings(cwd: string | undefined, warn: (m: string) => void): Partial<Settings> {
  let out: Partial<Settings> = {};
  for (const f of [join(homedir(), ".pi", "agent", "context-stack.json"), cwd ? join(cwd, ".pi", "context-stack.json") : ""]) {
    if (!f || !existsSync(f)) continue;
    try { out = { ...out, ...parseSettings(JSON.parse(readFileSync(f, "utf8"))) }; }
    catch (e) { warn(`context-stack: ignoring ${f}: ${(e as Error).message}`); }
  }
  const env = process.env;
  try {
    out = { ...out, ...parseSettings({ enabled: env.PI_CONTEXT_STACK_ENABLED, every: env.PI_CONTEXT_STACK_EVERY, keep: env.PI_CONTEXT_STACK_KEEP, density: env.PI_CONTEXT_STACK_DENSITY, replaceCompaction: env.PI_CONTEXT_STACK_REPLACE_COMPACTION }) };
  } catch (e) { warn(`context-stack: ignoring environment: ${(e as Error).message}`); }
  return out;
}

export default function contextStack(pi: ExtensionAPI) {
  let state: StackState = emptyState();
  let pending: "none" | "wanted" | "asked" = "none";
  let cut: (Cut & { askedAt: number }) | null = null; // the span the pending summary request covers
  let resume = false;       // the checkpoint interrupted a run: continue it after the summary
  let watchResume = false;  // a resumed run has not yet made a tool call: nudge once if it settles
  let warmUntil = 0;
  let liveTail = 0;         // estimated tokens of the live tail, as of the last request
  let lastTurnAt = 0;
  let ctxRef: any = null;
  let stopControl: (() => void) | null = null;

  pi.registerFlag("context-stack", { type: "boolean", default: false, description: "Force checkpoints on for this session" });
  pi.registerFlag("context-stack-every", { type: "string", description: "Checkpoint every N tokens of growth (100k) or share of the window (10%)" });

  const branchMessages = (ctx: any): { id: string; m: MessageLike }[] =>
    (ctx?.sessionManager?.getBranch?.() ?? [])
      .filter((e: any) => e.type === "message" && e.message)
      .map((e: any) => ({ id: e.id, m: e.message as MessageLike }));
  const sessionMessages = () => branchMessages(ctxRef).map((x) => x.m);
  const contextWindow = (): number | undefined => ctxRef?.getContextUsage?.()?.contextWindow ?? ctxRef?.model?.contextWindow;
  const everyNow = () => everyTokens(state.every, contextWindow());

  const status = () => ({
    pid: process.pid,
    sessionId: ctxRef?.sessionManager?.getSessionId?.() ?? null,
    cwd: ctxRef?.cwd ?? null,
    enabled: state.enabled,
    every: state.every,
    everyTokens: everyNow(),
    keep: state.keep,
    density: state.density,
    replaceCompaction: state.replaceCompaction,
    liveTail,
    anchorTs: state.anchorTs,
    checkpoints: state.checkpoints.length,
    stackTokens: state.checkpoints.reduce((a, c) => a + (c.summaryTokens ?? 0), 0),
    replacedTokens: state.checkpoints.reduce((a, c) => a + (c.spanTokens ?? 0), 0),
    lastCutTs: state.checkpoints.at(-1)?.cutTs ?? null,
    pending,
    idle: ctxRef?.isIdle?.() ?? null,
    idleSec: lastTurnAt ? Math.round((Date.now() - lastTurnAt) / 1000) : null,
    warmUntil: warmUntil > Date.now() ? warmUntil : null,
  });
  const announce = () => pi.events.emit("context-stack:status", status());

  /** Persist a settings change for this session (it then beats files, env and flags on resume). */
  const save = (patch: Partial<StackState>) => {
    state = { ...state, ...patch };
    const { enabled, anchorTs, every, keep, density, replaceCompaction } = state;
    pi.appendEntry(STATE, { enabled, anchorTs, every, keep, density, replaceCompaction });
    announce();
  };

  const resolveAnchor = (needle: string | undefined): number | null =>
    needle ? anchorFor(sessionMessages(), needle) : state.anchorTs;

  /** Pick the span and build the summary request for it. null = nothing to summarise. */
  const prepareAsk = () => {
    const c = chooseCut(sessionMessages(), state);
    if (!c) return null;
    cut = { ...c, askedAt: Date.now() };
    pending = "asked";
    announce();
    return { customType: PROMPT_TYPE, content: summaryPrompt(c, state.density), display: false };
  };

  /** One checkpoint request. Mid-run: at the next turn boundary. Idle: now, as its own turn. */
  const checkpointNow = (opts: { maxIdleSec?: number } = {}) => {
    if (pending !== "none") return; // one at a time
    const idle = ctxRef?.isIdle?.() !== false;
    if (idle && opts.maxIdleSec !== undefined) {
      const age = lastTurnAt ? (Date.now() - lastTurnAt) / 1000 : Infinity;
      if (age > opts.maxIdleSec) throw new Error(`cache likely cold: last turn ${Number.isFinite(age) ? Math.round(age) + "s" : "never"} ago > max-idle ${opts.maxIdleSec}s`);
    }
    if (idle && ctxRef && !chooseCut(sessionMessages(), state)) throw new Error("nothing new since the last checkpoint");
    if (!state.enabled) save({ enabled: true });
    if (!idle) { pending = "wanted"; announce(); return; }
    const ask = prepareAsk();
    if (!ask) return;
    resume = false;
    pi.sendMessage(ask, { triggerTurn: true });
  };

  /** Every external surface (CLI socket, pi.events, /stack) lands here. Returns the status after the op. */
  const command = (d: Record<string, any>) => {
    const op = d.op ?? "status";
    if (op === "enable") {
      const a = d.anchor ? resolveAnchor(d.anchor) : (d.anchorTs ?? state.anchorTs);
      if (d.anchor && a === null) throw new Error(`no user message contains "${d.anchor}"`);
      save({ enabled: true, anchorTs: a });
    } else if (op === "disable") save({ enabled: false });
    else if (op === "checkpoint") checkpointNow({ maxIdleSec: d.maxIdleSec });
    else if (op === "every" || op === "keep" || op === "density") {
      const patch = parseSettings({ [op]: d.value ?? d.tokens });
      save({ ...patch, enabled: op === "every" && patch.every === null ? state.enabled : true });
    } else if (op === "warm") { warmUntil = d.minutes > 0 ? Date.now() + d.minutes * 60_000 : 0; announce(); }
    else if (op === "rewind") {
      const k = d.checkpoint === undefined || d.checkpoint === "last" ? state.checkpoints.length : Number(d.checkpoint);
      if (!state.checkpoints[k - 1]) throw new Error(`no checkpoint ${d.checkpoint ?? "yet"}; there are ${state.checkpoints.length}`);
      // Moving the leaf needs a command context: run it as the /stack command (pi waits for idle there).
      pi.sendUserMessage(`/stack rewind ${k}`, { expandPromptTemplates: true, deliverAs: "followUp" } as any);
    }
    else if (op === "status") announce(); // an in-process caller hears it on context-stack:status
    else throw new Error(`unknown op "${op}"`);
    return status();
  };

  /** Settings, then this branch's saved state and checkpoints. Abandoned branches are alternative histories. */
  const restore = (ctx: any) => {
    ctxRef = ctx;
    pending = "none";
    cut = null;
    resume = false;
    watchResume = false;
    liveTail = 0;
    const warn = (m: string) => ctx.ui?.notify?.(m, "warning");
    let base: StackState = { ...emptyState(), ...DEFAULTS, ...fileSettings(ctx.cwd, warn) };
    try { if (pi.getFlag("context-stack-every")) base = { ...base, ...parseSettings({ every: pi.getFlag("context-stack-every") }), enabled: true }; }
    catch (e) { warn(`context-stack: --context-stack-every: ${(e as Error).message}`); }
    if (pi.getFlag("context-stack") === true) base.enabled = true;
    state = base;
    for (const e of ctx.sessionManager?.getBranch?.() ?? []) {
      // A compaction (pi's, or one another extension supplied) replaced the conversation: summaries of what came before it are void.
      if (e.type === "compaction") { state = { ...state, checkpoints: [], anchorTs: null }; continue; }
      if (e.type !== "custom") continue;
      if (e.customType === STATE && e.data) {
        const d = e.data;
        state = { ...state, enabled: !!d.enabled, anchorTs: d.anchorTs ?? null };
        if ("every" in d) state.every = d.every ?? null;
        if (typeof d.keep === "number") state.keep = d.keep;
        if (typeof d.density === "number") state.density = d.density;
        if (typeof d.replaceCompaction === "boolean") state.replaceCompaction = d.replaceCompaction;
      }
      if (e.customType === CHECKPOINT) state = { ...state, checkpoints: [...state.checkpoints, e.data as Checkpoint] };
    }
  };

  pi.on("session_start", async (_e: any, ctx: any) => {
    restore(ctx);
    const warn = (m: string) => ctx.ui?.notify?.(m, "warning");
    stopControl?.();
    try {
      stopControl = startControl({
        sessionId: ctx.sessionManager?.getSessionId?.() ?? null,
        sessionFile: ctx.sessionManager?.getSessionFile?.() ?? null,
        cwd: ctx.cwd,
        tmuxPane: process.env.TMUX_PANE ?? null,
        tmux: process.env.TMUX ?? null,
      }, command);
    } catch (e) { warn(`context-stack: control socket unavailable (${(e as Error).message})`); }
    announce();
  });

  // A compaction (pi's own, or a reset another extension supplied) replaced the conversation: start a new stack after it.
  pi.on("session_compact", async () => {
    state = { ...state, checkpoints: [], anchorTs: null };
    pending = "none"; cut = null; resume = false; watchResume = false; liveTail = 0;
    announce();
  });

  // /tree or a rewind moved the leaf: the checkpoints on the new branch are the stack.
  pi.on("session_tree", async (_e: any, ctx: any) => { restore(ctx); announce(); });

  pi.on("session_shutdown", async () => { stopControl?.(); stopControl = null; });

  // The projection: the whole point. Fails open (returns nothing) when it cannot place the anchor.
  pi.on("context", async (event: any) => {
    if (!state.enabled) return;
    liveTail = tailTokens(event.messages as MessageLike[], state);
    const projected = project(event.messages as MessageLike[], state);
    return projected ? { messages: projected as any } : undefined;
  });

  // Anthropic: keep a cache breakpoint on the newest summary even when kept messages follow it.
  pi.on("before_provider_request", (event: any) => {
    if (!state.enabled || state.checkpoints.length === 0) return;
    return placeSummaryBreakpoint(event.payload, state.checkpoints.length);
  });

  // Replace threshold compaction with a checkpoint. Overflow recovery and manual /compact stay pi's.
  pi.on("session_before_compact", async (event: any, ctx: any) => {
    if (!state.enabled || !state.replaceCompaction || event.reason !== "threshold") return;
    if (pending === "none") pending = "wanted";
    ctx.ui?.notify?.("context-stack: taking a checkpoint instead of compacting", "info");
    announce();
    return { cancel: true };
  });

  // Ask for the summary at a turn boundary, then capture the reply at the next one.
  pi.on("turn_end", async (event: any) => {
    lastTurnAt = Date.now();
    if (pending === "asked" && cut) {
      const msgs: MessageLike[] = event.context?.contextMessages ?? [];
      const reply = [...msgs].reverse().find((m) => m.role === "assistant");
      const text = reply ? textOf(reply) : "";
      if (!reply || !text || reply.timestamp === undefined || reply.timestamp < cut.askedAt) return; // wait for the answer
      const summary = text.replace(SUMMARY_MARKER, "").trim();
      const cp: Checkpoint = {
        k: state.checkpoints.length + 1, summary, cutTs: cut.cutTs, fromTs: cut.fromTs, replyTs: reply.timestamp,
        takenAt: Date.now(), spanTokens: cut.spanTokens, summaryTokens: estimateTokens([{ role: "custom", content: summary }]),
      };
      state = { ...state, checkpoints: [...state.checkpoints, cp] };
      pending = "none";
      cut = null;
      liveTail = 0;
      const entries: any[] = [{ type: "custom", customType: CHECKPOINT, data: cp }];
      const wasMidRun = resume;
      resume = false;
      announce();
      if (!wasMidRun) return { entries };
      watchResume = true;
      entries.push({ type: "custom_message", customType: RESUME_TYPE, content: RESUME_LINE, display: false });
      return { entries, continue: true };
    }
    if ((event.toolResults?.length ?? 0) > 0) watchResume = false; // the resumed run is working again
    // liveTail is as of this turn's request; add what the turn itself produced, or the trigger lags a turn.
    const grown = liveTail + estimateTokens([event.message, ...(event.toolResults ?? [])]);
    const every = everyNow();
    if (pending === "none" && state.enabled && every && grown >= every) pending = "wanted";
    if (pending === "wanted") {
      resume = (event.toolResults?.length ?? 0) > 0; // tool results pending = the run was going to continue
      const ask = prepareAsk();
      if (!ask) { pending = "none"; announce(); return; }
      return { entries: [{ type: "custom_message", ...ask }], continue: true };
    }
  });

  // Live run 2026-10-18 (a local 27B model): after a mid-run checkpoint the model sometimes answers text-only, which
  // ends pi's run mid-task. One nudge per checkpoint; a model that really is done just answers again.
  pi.on("agent_before_settle", async () => {
    if (!watchResume || pending !== "none") return;
    watchResume = false;
    return { entries: [{ type: "custom_message", customType: NUDGE_TYPE, content: NUDGE_PROMPT, display: false }], continue: true };
  });

  // Keep the cache warm while someone (an orchestrator) says a real request is coming. pi caps idle warming at
  // 30 minutes regardless; this only overrides pi's per-refresh warm/stop decision inside that cap.
  pi.on("cache_warming_decision", async () => (warmUntil > Date.now() ? { action: "warm" } : undefined));

  // Lossless: the originals behind any summary, verbatim, read back as an ordinary (appended) tool result.
  pi.registerTool({
    name: RECALL_TOOL,
    label: "Recall checkpoint",
    description:
      "Read the verbatim original messages that a context-stack checkpoint summary replaced. Use it when a summary " +
      "lacks a detail you need (exact text, numbers, file contents, tool output). Checkpoints are numbered 1..k, as in " +
      `"${SUMMARY_MARKER} k". Prefer \`match\` for a specific detail: it returns only the matching lines, while a whole ` +
      "span can be tens of thousands of tokens. Without it, spans come back in slices: pass the returned next offset to continue.",
    // Plain JSON schema (pi validates and coerces it): no runtime dependency on pi-ai.
    parameters: {
      type: "object",
      properties: {
        checkpoint: { type: "integer", minimum: 1, description: "Checkpoint number k" },
        offset: { type: "integer", minimum: 0, description: "Character offset into the span (default 0)" },
        limit: { type: "integer", minimum: 1000, maximum: 100000, description: "Characters to return (default 20000)" },
        match: { type: "string", description: "Only lines containing this text (case-insensitive), with 1 line of context each" },
      },
      required: ["checkpoint"],
    },
    async execute(_id: string, params: { checkpoint: number; offset?: number; limit?: number; match?: string }) {
      const k = params.checkpoint;
      if (!state.checkpoints[k - 1]) throw new Error(`no checkpoint ${k}; there are ${state.checkpoints.length}`);
      let text = render(spanOf(sessionMessages(), state, k));
      if (params.match) {
        const lines = text.split("\n");
        const needle = params.match.toLowerCase();
        const keep = new Set<number>();
        lines.forEach((l, i) => { if (l.toLowerCase().includes(needle)) for (let j = i - 1; j <= i + 1; j++) if (j >= 0 && j < lines.length) keep.add(j); });
        if (!keep.size) return { content: [{ type: "text", text: `no line in checkpoint ${k} contains "${params.match}"` }], details: { k, matches: 0 } };
        const out: string[] = [];
        let last = -2;
        for (const i of [...keep].sort((a, b) => a - b)) { if (i > last + 1) out.push("…"); out.push(lines[i]); last = i; }
        text = out.join("\n");
      }
      const from = Math.min(params.offset ?? 0, text.length);
      const to = Math.min(text.length, from + (params.limit ?? 20000));
      const more = to < text.length ? `\n\n[chars ${from}-${to} of ${text.length}; continue with offset=${to}]` : `\n\n[chars ${from}-${to} of ${text.length}: end of checkpoint ${k}]`;
      return { content: [{ type: "text", text: text.slice(from, to) + more }], details: { k, from, to, total: text.length } };
    },
  } as any);

  const sliceTo = (ctx: any, anchorTs: number, file: string) => {
    const lines: string[] = [`# Session slice after anchor ${new Date(anchorTs).toISOString()}`, ""];
    lines.push(render(branchMessages(ctx).map((x) => x.m).filter((m) => (m.timestamp ?? 0) > anchorTs)));
    const out = resolve(ctx.cwd ?? process.cwd(), file);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, lines.join("\n"));
    return out;
  };

  const argOf = (args: string, name: string): string | undefined => {
    const m = args.match(new RegExp(`--${name}\\s+(?:"([^"]+)"|(\\S+))`));
    return m ? (m[1] ?? m[2]) : undefined;
  };

  pi.registerCommand("stack", {
    description: "Checkpoints instead of compaction: on [--anchor \"text\"] | off | checkpoint | every <10%|100k|off> | keep <20%> | density <5%> | rewind [k|last] | rewind --anchor \"text\" [--slice file] | slice --anchor \"text\" file | warm <min>|off | status",
    handler: async (args: string, ctx: any) => {
      const [op, arg1] = args.trim().split(/\s+/);
      const anchorText = argOf(args, "anchor");
      try {
        if (op === "on") command({ op: "enable", anchor: anchorText });
        else if (op === "off") command({ op: "disable" });
        else if (op === "checkpoint") command({ op: "checkpoint" });
        else if (op === "every" || op === "keep" || op === "density") command({ op, value: arg1 });
        else if (op === "warm") command({ op: "warm", minutes: Number(arg1) || 0 });
        else if (op === "rewind" && !anchorText) {
          // Back to checkpoint k as it was taken: task + S1..Sk (+ what it kept). Everything after leaves the
          // branch (still in the session file, reachable from /tree). The leaf goes on the checkpoint entry.
          const k = arg1 === undefined || arg1 === "last" ? state.checkpoints.length : Number(arg1);
          const entries = ctx.sessionManager?.getBranch?.() ?? [];
          const target = entries.find((e: any) => e.type === "custom" && e.customType === CHECKPOINT && e.data?.k === k);
          if (!target) return ctx.ui.notify(`context-stack: no checkpoint ${arg1 ?? "yet"} on this branch (there are ${state.checkpoints.length})`, "error");
          await ctx.waitForIdle?.();
          const r = await ctx.navigateTree(target.id, { summarize: false, label: `context-stack rewind to checkpoint ${k}` });
          if (r?.cancelled) return ctx.ui.notify("context-stack: rewind cancelled", "warning");
        }
        else if (op === "slice" || op === "rewind") {
          const a = resolveAnchor(anchorText);
          if (a === null) return ctx.ui.notify("context-stack: give --anchor \"<text of a user message>\"", "error");
          const file = op === "slice" ? args.replace(/--anchor\s+("[^"]+"|\S+)/, "").trim().split(/\s+/)[1] : argOf(args, "slice");
          if (file) ctx.ui.notify(`context-stack: slice written to ${sliceTo(ctx, a, file)}`, "info");
          if (op === "rewind") {
            const target = branchMessages(ctx).find((x) => x.m.timestamp === a);
            if (!target) return ctx.ui.notify("context-stack: anchor entry not on this branch", "error");
            await ctx.waitForIdle?.();
            const r = await ctx.navigateTree(target.id, { summarize: false, label: "context-stack rewind" });
            if (r?.cancelled) return ctx.ui.notify("context-stack: rewind cancelled", "warning");
          }
        }
      } catch (e) { return ctx.ui.notify(`context-stack: ${(e as Error).message}`, "error"); }
      ctx.ui.notify(`context-stack: ${JSON.stringify(status())}`, "info");
    },
  });

  // The in-process interface for other extensions: same operations as the CLI. Rewind needs a command context.
  pi.events.on("context-stack:command", (data: unknown) => {
    try { command((data ?? {}) as Record<string, any>); } catch { announce(); }
  });
}
