import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import contextStack from "../src/extension.ts";
import { RESUME_TYPE, PROMPT_TYPE, SUMMARY_TYPE } from "../src/stack.ts";

const scratch = () => { const d = join(import.meta.dirname, "..", ".scratch"); mkdirSync(d, { recursive: true }); return mkdtempSync(join(d, "t-")); };
process.env.PI_CONTEXT_STACK_DIR = scratch();

/** A fake pi plus a fake session whose branch the test appends to, as pi would. */
function harness(flags: Record<string, unknown> = {}, cwd = "/nonexistent") {
  const handlers: Record<string, Function> = {}; const bus: Record<string, Function[]> = {}; const sent: any[] = []; const tools: any[] = []; const commands: Record<string, any> = {}; const userMsgs: any[] = [];
  const branch: any[] = [];
  let t = Date.now() - 1_000_000;
  const pi: any = {
    on: (e: string, h: Function) => { handlers[e] = h; return () => {}; },
    registerFlag: () => {}, getFlag: (n: string) => flags[n], registerCommand: (n: string, c: any) => (commands[n] = c), registerTool: (x: any) => tools.push(x),
    sendUserMessage: (t: string, o: any) => userMsgs.push({ t, o }),
    appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
    sendMessage: (m: unknown) => sent.push(m),
    events: { emit: (c: string, d: unknown) => (bus[c] ?? []).forEach((h) => h(d)), on: (c: string, h: Function) => { (bus[c] ??= []).push(h); return () => {}; } },
  };
  contextStack(pi);
  after(() => handlers.session_shutdown?.({})); // close control sockets so the test process can exit
  let idle = true;
  const ctx = { cwd, isIdle: () => idle, getContextUsage: () => ({ contextWindow: 100_000 }), sessionManager: { getBranch: () => branch, getSessionId: () => "abc123" } };
  const add = (role: string, text: string, extra: any = {}) => {
    const m = { role, timestamp: (t += 1000), content: [{ type: "text", text }], ...extra };
    branch.push({ type: "message", id: `e${branch.length}`, message: m });
    return m;
  };
  const msgs = () => branch.filter((e) => e.type === "message").map((e) => e.message);
  /** What turn_end's boundary entries would append to the session. */
  const apply = (r: any) => { for (const e of r?.entries ?? []) e.type === "custom" ? branch.push(e) : add("custom", e.content, { customType: e.customType, content: e.content }); return r; };
  const reply = (text: string) => { const m = add("assistant", text); m.timestamp = Date.now() + 10; return m; };
  return { handlers, bus, sent, tools, commands, userMsgs, branch, ctx, add, msgs, apply, reply, pi, setIdle: (v: boolean) => (idle = v) };
}
const x = (n: number) => "x".repeat(n);

test("threshold compaction becomes a checkpoint: cancel, ask with a density target, capture, project", async () => {
  const h = harness();
  await h.handlers.session_start({}, h.ctx);
  h.add("user", "THE TASK"); h.add("assistant", x(4000)); h.add("user", x(4000));
  assert.deepEqual(await h.handlers.session_before_compact({ reason: "threshold" }, {}), { cancel: true });
  assert.equal(await h.handlers.session_before_compact({ reason: "overflow" }, {}), undefined, "overflow recovery stays with pi");
  const ask = h.apply(await h.handlers.turn_end({ toolResults: [] }));
  assert.equal(ask.continue, true);
  assert.match(ask.entries[0].content, /about 200 tokens/, "5% of ~2k tokens, floored at 200");
  const r = h.reply("THE SUMMARY");
  h.apply(await h.handlers.turn_end({ toolResults: [], context: { contextMessages: h.msgs() } }));
  const out = (await h.handlers.context({ messages: h.msgs() })).messages;
  assert.deepEqual(out.map((m: any) => m.customType ?? m.role), ["user", SUMMARY_TYPE, "user"], "task, S1, then the active request; the summary request and reply are hidden");
  assert.ok(r.timestamp);
});

test("keep 50%: the newest half of the tail stays verbatim after S1, never starting on a tool result", async () => {
  const h = harness();
  await h.handlers.session_start({}, h.ctx);
  h.pi.events.emit("context-stack:command", { op: "keep", value: "50%" });
  h.add("user", "THE TASK");
  for (let i = 1; i <= 4; i++) { h.add("assistant", `call ${i}`); h.add("toolResult", `RESULT ${i} ` + x(4000)); }
  h.pi.events.emit("context-stack:command", { op: "checkpoint" }); // idle: sent as its own turn
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].content, /BEFORE the assistant message that begins "call 3"/);
  h.add("custom", h.sent[0].content, { customType: PROMPT_TYPE, content: h.sent[0].content });
  h.reply("S1: results 1 and 2");
  h.apply(await h.handlers.turn_end({ toolResults: [], context: { contextMessages: h.msgs() } }));
  const out = (await h.handlers.context({ messages: h.msgs() })).messages;
  assert.deepEqual(out.map((m: any) => m.customType ?? textOf(m).slice(0, 8)), ["THE TASK", SUMMARY_TYPE, "call 3", "RESULT 3", "call 4", "RESULT 4"]);
  // Lossless: the recall tool returns what S1 replaced, verbatim.
  const recall = await h.tools[0].execute("id", { checkpoint: 1 });
  assert.match(recall.content[0].text, /RESULT 1 x+/);
  assert.match(recall.content[0].text, /RESULT 2/);
  assert.doesNotMatch(recall.content[0].text, /RESULT 3|THE TASK|checkpoint summary/);
  const hit = await h.tools[0].execute("id", { checkpoint: 1, match: "result 2" });
  assert.match(hit.content[0].text, /RESULT 2/);
  assert.doesNotMatch(hit.content[0].text, /RESULT 1/, "match returns only the matching lines");
  assert.match((await h.tools[0].execute("id", { checkpoint: 1, match: "nowhere" })).content[0].text, /no line/);
  const slice = await h.tools[0].execute("id", { checkpoint: 1, limit: 1000 });
  assert.match(slice.content[0].text, /continue with offset=1000/);
});
const textOf = (m: any) => (typeof m.content === "string" ? m.content : m.content.map((c: any) => c.text).join(""));

test("every (share of the window): growth past it asks mid-run, captures, resumes, nudges once", async () => {
  const h = harness({ "context-stack-every": "2%" }); // 2% of 100k = 2k tokens
  await h.handlers.session_start({}, h.ctx);
  h.add("user", "THE TASK");
  h.add("assistant", "read"); h.add("toolResult", x(4000));
  await h.handlers.context({ messages: h.msgs() });
  assert.equal(await h.handlers.turn_end({ toolResults: [{}], message: {} }), undefined, "~1k tokens: below");
  h.add("assistant", "read"); const tr = h.add("toolResult", x(6000));
  const ask = h.apply(await h.handlers.turn_end({ toolResults: [tr], message: {} }));
  assert.equal(ask.continue, true);
  h.reply("S1");
  const cap = h.apply(await h.handlers.turn_end({ toolResults: [], context: { contextMessages: h.msgs() } }));
  assert.equal(cap.entries[1].customType, RESUME_TYPE, "mid-run checkpoint resumes the run");
  assert.equal(cap.continue, true);
  assert.equal(await h.handlers.turn_end({ toolResults: [] }), undefined, "resumed run answers text-only");
  assert.equal((await h.handlers.agent_before_settle({})).continue, true, "one nudge so an agent does not stop mid-task");
  assert.equal(await h.handlers.agent_before_settle({}), undefined, "and only one");
});

test("settings: project file beats defaults, env beats the file, the session beats both", async () => {
  const cwd = scratch(); mkdirSync(join(cwd, ".pi"));
  writeFileSync(join(cwd, ".pi", "context-stack.json"), JSON.stringify({ every: "50k", keep: "20%", density: "3%" }));
  process.env.PI_CONTEXT_STACK_KEEP = "10%";
  const h = harness({}, cwd);
  await h.handlers.session_start({}, h.ctx);
  let s: any; h.pi.events.on("context-stack:status", (v: any) => (s = v));
  h.pi.events.emit("context-stack:command", { op: "status" });
  assert.deepEqual([s.enabled, s.every, s.keep, s.density], [true, 50000, 0.1, 0.03]);
  h.pi.events.emit("context-stack:command", { op: "density", value: "8%" });
  await h.handlers.session_start({}, h.ctx); // resume: the saved session value wins
  h.pi.events.emit("context-stack:command", { op: "status" });
  assert.equal(s.density, 0.08);
  delete process.env.PI_CONTEXT_STACK_KEEP;
  await h.handlers.session_shutdown({});
});

test("disabled by setting: compaction untouched, context passes through", async () => {
  process.env.PI_CONTEXT_STACK_ENABLED = "0";
  const h = harness();
  await h.handlers.session_start({}, h.ctx);
  delete process.env.PI_CONTEXT_STACK_ENABLED;
  assert.equal(await h.handlers.session_before_compact({ reason: "threshold" }, {}), undefined);
  assert.equal(await h.handlers.context({ messages: [{ role: "user", timestamp: 1, content: "x" }] }), undefined);
  await h.handlers.session_shutdown({});
});

test("another extension can hold the cache warm for a stated window", async () => {
  const h = harness();
  assert.equal(await h.handlers.cache_warming_decision({}), undefined);
  h.pi.events.emit("context-stack:command", { op: "warm", minutes: 10 });
  assert.deepEqual(await h.handlers.cache_warming_decision({}), { action: "warm" });
});

test("the CLI reaches the session over its socket: settings, refusals, checkpoint while idle", async () => {
  const dir = scratch();
  process.env.PI_CONTEXT_STACK_DIR = dir;
  const h = harness();
  await h.handlers.session_start({}, h.ctx);
  const cli = (...a: string[]) => new Promise<{ code: number; out: string }>((ok) =>
    execFile(process.execPath, [join(import.meta.dirname, "..", "bin", "pi-context-stack.mjs"), ...a], { env: { ...process.env, PI_CONTEXT_STACK_DIR: dir } },
      (e, out, err) => ok({ code: (e as any)?.code ?? 0, out: out + err })));
  assert.match((await cli("list")).out, new RegExp(`^${process.pid}\\s+abc123`, "m"));
  for (const [op, v, re] of [["every", "50k", /every 50k/], ["every", "15%", /every 15%/], ["keep", "20%", /keep 20%/], ["density", "4%", /density 4%/]] as const) {
    const r = await cli(op, v, String(process.pid));
    assert.equal(r.code, 0, r.out); assert.match(r.out, re);
  }
  assert.equal((await cli("every", "lots", "all")).code, 1);
  assert.match((await cli("checkpoint", "abc")).out, /nothing new/);
  h.add("user", "THE TASK"); h.add("assistant", x(800));
  await h.handlers.turn_end({ toolResults: [] });
  assert.match((await cli("checkpoint", "abc", "--max-idle", "-1")).out, /cache likely cold/);
  const cp = await cli("checkpoint", "abc", "--max-idle", "600");
  assert.equal(cp.code, 0, cp.out);
  assert.equal(h.sent.length, 1, "idle session: the summary request is sent as its own turn");
  assert.match((await cli("status", "abc")).out, /asked/);
  await h.handlers.session_shutdown({});
  assert.match((await cli("list")).out, /no pi sessions/);
});

test("rewind to the last checkpoint: the leaf moves onto its entry, the stack is rebuilt from that branch", async () => {
  const h = harness();
  await h.handlers.session_start({}, h.ctx);
  h.add("user", "THE TASK"); h.add("assistant", x(4000));
  h.pi.events.emit("context-stack:command", { op: "checkpoint" });
  h.add("custom", h.sent[0].content, { customType: PROMPT_TYPE, content: h.sent[0].content });
  h.reply("S1");
  h.apply(await h.handlers.turn_end({ toolResults: [], context: { contextMessages: h.msgs() } }));
  const cpEntry = h.branch.find((e) => e.customType === "context-stack:checkpoint");
  h.add("user", "later work"); h.add("assistant", "LATER");
  let navigated: string | null = null;
  const notes: string[] = [];
  const cmdCtx = { ...h.ctx, waitForIdle: async () => {}, ui: { notify: (m: string) => notes.push(m) },
    navigateTree: async (id: string) => { navigated = id; const i = h.branch.indexOf(cpEntry); h.branch.splice(i + 1); return { cancelled: false }; } };
  await h.commands.stack.handler("rewind last", cmdCtx);
  assert.equal(navigated, cpEntry.id, "leaf goes onto checkpoint 1's own entry");
  await h.handlers.session_tree({}, h.ctx);
  const out = (await h.handlers.context({ messages: h.msgs() })).messages;
  assert.deepEqual(out.map((m: any) => m.customType ?? m.role), ["user", SUMMARY_TYPE], "task + S1, the later work is off the branch");
  await h.commands.stack.handler("rewind 7", cmdCtx);
  assert.match(notes.at(-1)!, /no checkpoint 7/);
  // From the CLI/bus: queued as the /stack command, which has the command context pi requires.
  h.pi.events.emit("context-stack:command", { op: "rewind", checkpoint: "last" });
  assert.deepEqual(h.userMsgs.at(-1), { t: "/stack rewind 1", o: { expandPromptTemplates: true, deliverAs: "followUp" } });
});

test("event-driven only: every off + replaceCompaction off = no checkpoint until asked", async () => {
  process.env.PI_CONTEXT_STACK_EVERY = "off"; process.env.PI_CONTEXT_STACK_REPLACE_COMPACTION = "false";
  const h = harness();
  await h.handlers.session_start({}, h.ctx);
  delete process.env.PI_CONTEXT_STACK_EVERY; delete process.env.PI_CONTEXT_STACK_REPLACE_COMPACTION;
  h.add("user", "THE TASK"); h.add("assistant", "read"); const tr = h.add("toolResult", x(400000));
  await h.handlers.context({ messages: h.msgs() });
  assert.equal(await h.handlers.turn_end({ toolResults: [tr], message: {} }), undefined, "100k tokens of growth: no checkpoint");
  assert.equal(await h.handlers.session_before_compact({ reason: "threshold" }, {}), undefined, "pi (or another extension) keeps its compaction");
  h.pi.events.emit("context-stack:command", { op: "checkpoint" });
  assert.equal(h.sent.length, 1, "an explicit request (the event) still checkpoints");
});

test("a compaction (e.g. an orchestrator's reset) voids the stack: no stale summaries in the fresh start", async () => {
  const h = harness();
  await h.handlers.session_start({}, h.ctx);
  h.add("user", "THE TASK"); h.add("assistant", x(4000));
  h.pi.events.emit("context-stack:command", { op: "checkpoint" });
  h.add("custom", h.sent[0].content, { customType: PROMPT_TYPE, content: h.sent[0].content });
  h.reply("S1");
  h.apply(await h.handlers.turn_end({ toolResults: [], context: { contextMessages: h.msgs() } }));
  h.branch.push({ type: "compaction", summary: "the brief and the map" });
  await h.handlers.session_compact({});
  const fresh = [{ role: "user", timestamp: Date.now() + 100, content: "brief for the next task" }];
  assert.equal(await h.handlers.context({ messages: fresh }), undefined, "live: nothing projected after the reset");
  await h.handlers.session_start({}, h.ctx); // and after a resume, rebuilt from the branch
  assert.equal(await h.handlers.context({ messages: fresh }), undefined, "resumed: the checkpoint before the compaction is void");
});

test("reference mode (density 0): no summary turn; an index of the span pointing at recall; the originals stay reachable", async () => {
  process.env.PI_CONTEXT_STACK_DENSITY = "0";
  const h = harness();
  await h.handlers.session_start({}, h.ctx);
  delete process.env.PI_CONTEXT_STACK_DENSITY;
  h.add("user", "THE TASK");
  h.add("assistant", "reading", { content: [{ type: "text", text: "reading the config" }, { type: "toolCall", name: "read", arguments: { path: "src/a.ts" } }] });
  h.add("toolResult", "CONFIG BODY " + x(4000));
  h.add("assistant", "edit", { content: [{ type: "text", text: "Fixed the parser; next I run the tests." }, { type: "toolCall", name: "edit", arguments: { path: "src/b.ts" } }, { type: "toolCall", name: "bash", arguments: { command: "npm test" } }] });
  h.pi.events.emit("context-stack:command", { op: "checkpoint" }); // idle: recorded at once
  assert.equal(h.sent.length, 0, "no model turn");
  const cp = h.branch.find((e) => e.customType === "context-stack:checkpoint").data;
  // the newest step (the edit + test run nobody has seen the results of) stays verbatim; the rest is indexed
  assert.match(cp.summary, /Not summarised: 2 messages/);
  assert.match(cp.summary, /Files read: src\/a.ts/);
  assert.match(cp.summary, /Files written: none/);
  assert.match(cp.summary, /Last said: reading the config/);
  const out = (await h.handlers.context({ messages: h.msgs() })).messages;
  assert.deepEqual(out.map((m: any) => m.customType ?? m.role), ["user", SUMMARY_TYPE, "assistant"]);
  const hit = (await h.tools[0].execute("id", { checkpoint: 1, match: "config body" })).content[0].text;
  assert.match(hit, /CONFIG BODY/);
  const anywhere = (await (0, h.tools[0].execute)("id", { match: "config body" })).content[0].text;
  assert.match(anywhere, /# checkpoint 1\n[^]*CONFIG BODY/, "no checkpoint number: every checkpoint is searched");
});

test("a caller-supplied summary (an orchestrator's record) is used verbatim, mid-run at the next boundary", async () => {
  const h = harness();
  await h.handlers.session_start({}, h.ctx);
  h.setIdle(false);
  h.add("user", "THE TASK"); h.add("assistant", x(2000)); const tr = h.add("toolResult", x(2000));
  h.pi.events.emit("context-stack:command", { op: "checkpoint", summary: "RECORD: task 7 shipped; next is task 8" });
  const r = await h.handlers.turn_end({ toolResults: [tr], message: {} });
  assert.equal(r.continue, undefined, "no extra turn: the run continues as pi would");
  assert.equal(r.entries[0].data.summary, "RECORD: task 7 shipped; next is task 8");
});
