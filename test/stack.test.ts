import { test } from "node:test";
import assert from "node:assert/strict";
import { anchorFor, emptyState, project, SUMMARY_TYPE } from "../src/stack.ts";

const m = (role: string, ts: number, text = `${role}-${ts}`) => ({ role, timestamp: ts, content: [{ type: "text", text }] });
const history = [m("user", 1, "start"), m("assistant", 2), m("user", 3, "the anchor prompt"), m("assistant", 4), m("user", 5), m("assistant", 6), m("user", 7), m("assistant", 8)];

test("off or without checkpoints the context is untouched", () => {
  assert.equal(project(history, emptyState()), null);
  assert.equal(project(history, { enabled: true, anchorTs: 4, checkpoints: [] }), null);
});

test("head up to the anchor, then the stack, then only the tail after the last cut", () => {
  const s = { enabled: true, anchorTs: 4, checkpoints: [{ k: 1, summary: "S1", cutTs: 6, takenAt: 100 }] };
  const out = project(history, s)!;
  assert.deepEqual(out.map((x: any) => x.timestamp), [1, 2, 3, 4, 100, 7, 8]);
  assert.equal((out[4] as any).customType, SUMMARY_TYPE);
});

test("stacking a second summary leaves every earlier byte identical (the cached prefix survives)", () => {
  const one = { enabled: true, anchorTs: 4, checkpoints: [{ k: 1, summary: "S1", cutTs: 6, takenAt: 100 }] };
  const two = { ...one, checkpoints: [...one.checkpoints, { k: 2, summary: "S2", cutTs: 8, takenAt: 200 }] };
  const a = JSON.stringify(project(history, one)!.slice(0, 5));
  const b = JSON.stringify(project(history, two)!.slice(0, 5));
  assert.equal(a, b);
  assert.deepEqual(project(history, two)!.map((x: any) => x.timestamp), [1, 2, 3, 4, 100, 200, 7], "S2 then the active request (7), which the cut passed");
});

test("an anchor that is not in the context fails open instead of dropping history", () => {
  assert.equal(project(history, { enabled: true, anchorTs: 999, checkpoints: [{ k: 1, summary: "S1", cutTs: 6, takenAt: 100 }] }), null);
});

test("the anchor is the end of the exchange the matching user message started", () => {
  assert.equal(anchorFor(history, "the anchor prompt"), 4);
  assert.equal(anchorFor(history, "missing"), null);
});

test("parseTokens reads 100k / 1.5m / plain / off, rejects junk", async () => {
  const { parseTokens } = await import("../src/stack.ts");
  assert.equal(parseTokens("100k"), 100000);
  assert.equal(parseTokens("1.5m"), 1500000);
  assert.equal(parseTokens(80000), 80000);
  assert.equal(parseTokens("off"), null);
  assert.equal(parseTokens("lots"), undefined);
  assert.equal(parseTokens(undefined), undefined);
});

test("tailTokens counts only what the next checkpoint would summarise", async () => {
  const { tailTokens } = await import("../src/stack.ts");
  const s = { enabled: true, anchorTs: 4, checkpoints: [{ k: 1, summary: "S1", cutTs: 6, takenAt: 100 }], every: null };
  const after = tailTokens(history, s);
  assert.ok(after > 0 && after < tailTokens(history, { ...s, checkpoints: [] }));
  assert.equal(tailTokens(history.slice(0, 6), s), 0, "nothing after the cut");
});

test("the summary request for checkpoint k+1 stays visible once a stack exists (live-run regression)", async () => {
  const { PROMPT_TYPE } = await import("../src/stack.ts");
  const s = { enabled: true, anchorTs: null, checkpoints: [{ k: 1, summary: "S1", cutTs: 6, takenAt: 100 }], every: null };
  const out = project([...history, { role: "custom", customType: PROMPT_TYPE, timestamp: 9, content: "summarise" }], s)!;
  assert.equal((out.at(-1) as any).customType, PROMPT_TYPE);
});

test("without an anchor the first user message (the task) stays verbatim ahead of the stack", () => {
  const s = { enabled: true, anchorTs: null, checkpoints: [{ k: 1, summary: "S1", cutTs: 6, takenAt: 100 }], every: null };
  assert.deepEqual(project(history, s)!.map((x: any) => x.timestamp), [1, 100, 7, 8]);
});

test("after a checkpoint: the summary closes with the resume line, the resume message is hidden, the active request follows", async () => {
  // The cache entry at Sk's end is held by placeSummaryBreakpoint (Anthropic): measured on Sonnet 5.5 with messages
  // after Sk, the next checkpoint still read [task..S(k-1)] from cache.
  const { RESUME_TYPE, RESUME_LINE } = await import("../src/stack.ts");
  const s = { enabled: true, anchorTs: null, checkpoints: [{ k: 1, summary: "S1", cutTs: 8, takenAt: 100 }], every: null };
  const out = project([...history, { role: "custom", customType: RESUME_TYPE, timestamp: 101, content: RESUME_LINE }], s)!;
  assert.deepEqual(out.map((x: any) => x.customType ?? x.timestamp), [1, SUMMARY_TYPE, 7]);
  assert.ok(String((out[1] as any).content).endsWith(RESUME_LINE));
});

test("chooseCut keeps the newest share verbatim and never starts it on a tool result", async () => {
  const { chooseCut } = await import("../src/stack.ts");
  const msgs = [m("user", 1, "task"), m("assistant", 2, "a"), m("toolResult", 3, "r".repeat(400)), m("assistant", 4, "b"), m("toolResult", 5, "r".repeat(400))];
  const s = { ...emptyState(), enabled: true, keep: 0.3 };
  const c = chooseCut(msgs, s)!;
  assert.deepEqual(c.kept.map((x) => x.timestamp), [], "30% would start the kept part on a tool result: summarise it with its call");
  const c2 = chooseCut(msgs, { ...s, keep: 0.6 })!;
  assert.deepEqual(c2.kept.map((x) => x.timestamp), [4, 5]);
  assert.equal(c2.cutTs, 3);
  assert.equal(chooseCut(msgs.slice(0, 1), s), null, "nothing after the task: nothing to summarise");
});

test("placeSummaryBreakpoint: adds one on the newest summary; when pi used all 4, moves the identity line's", async () => {
  const { placeSummaryBreakpoint, SUMMARY_MARKER } = await import("../src/stack.ts");
  const cc = { type: "ephemeral" };
  const mk = (sys: number) => ({
    tools: [{ name: "read", cache_control: cc }],
    system: Array.from({ length: sys }, (_, i) => ({ type: "text", text: `sys${i}`, cache_control: cc })),
    messages: [{ role: "user", content: [{ type: "text", text: "task" }, { type: "text", text: `${SUMMARY_MARKER} 1\n\nS1` }, { type: "text", text: "kept", cache_control: cc }] }],
  });
  const three = placeSummaryBreakpoint(mk(1), 1);
  assert.deepEqual(three.messages[0].content[1].cache_control, cc);
  const four = placeSummaryBreakpoint(mk(2), 1);
  assert.equal(four.system[0].cache_control, undefined);
  assert.deepEqual(four.system[1].cache_control, cc);
  assert.deepEqual(four.messages[0].content[1].cache_control, cc);
  const openai = { messages: [{ role: "user", content: [{ type: "text", text: `${SUMMARY_MARKER} 1` }] }] };
  assert.equal(JSON.stringify(placeSummaryBreakpoint(openai, 1)), JSON.stringify(openai), "no cache_control in the payload: untouched");
});

test("the newest user request is never folded away: kept verbatim after the stack when a cut passed it", () => {
  const msgs = [m("user", 1, "task"), m("assistant", 2), m("user", 3, "THE QUESTION"), m("assistant", 4), m("toolResult", 5, "r")];
  const s = { ...emptyState(), enabled: true, checkpoints: [{ k: 1, summary: "S1", cutTs: 5, takenAt: 100 }] };
  assert.deepEqual(project(msgs, s)!.map((x: any) => x.timestamp), [1, 100, 3], "task, S1, the question");
  const s2 = { ...s, checkpoints: [{ k: 1, summary: "S1", cutTs: 2, takenAt: 100 }] };
  assert.deepEqual(project(msgs, s2)!.map((x: any) => x.timestamp), [1, 100, 3, 4, 5], "already in the tail: not doubled");
});

test("reference mode never folds the newest step; recalled lines name the tool call they came from", async () => {
  const { chooseCut, render } = await import("../src/stack.ts");
  const call = (ts: number, id: string, path: string) => ({ role: "assistant", timestamp: ts, content: [{ type: "toolCall", id, name: "read", arguments: { path } }] });
  const res = (ts: number, id: string, text: string) => ({ role: "toolResult", timestamp: ts, toolCallId: id, content: [{ type: "text", text }] });
  const msgs = [m("user", 1, "task"), call(2, "c1", "a.txt"), res(3, "c1", "A " + "a".repeat(400)), call(4, "c2", "b.txt"), res(5, "c2", "B " + "b".repeat(400))];
  const c = chooseCut(msgs, { ...emptyState(), enabled: true, density: 0, keep: 0 })!;
  assert.deepEqual(c.kept.map((x) => x.timestamp), [4, 5], "the newest step (call + its result) stays");
  assert.equal(chooseCut(msgs.slice(0, 3), { ...emptyState(), enabled: true, density: 0, keep: 0 }), null, "only the newest step is new");
  assert.match(render(msgs), /## toolResult · [^\n]* · read \{"path":"b.txt"\}/);
});
