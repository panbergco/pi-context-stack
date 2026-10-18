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
  assert.deepEqual(project(history, two)!.map((x: any) => x.timestamp), [1, 2, 3, 4, 100, 200]);
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

test("the request right after a checkpoint ends AT the summary, so the cache breakpoint lands on it", async () => {
  const { RESUME_TYPE, RESUME_LINE } = await import("../src/stack.ts");
  const s = { enabled: true, anchorTs: null, checkpoints: [{ k: 1, summary: "S1", cutTs: 8, takenAt: 100 }], every: null };
  const out = project([...history, { role: "custom", customType: RESUME_TYPE, timestamp: 101, content: RESUME_LINE }], s)!;
  assert.equal((out.at(-1) as any).customType, SUMMARY_TYPE);
  assert.ok(String((out.at(-1) as any).content).endsWith(RESUME_LINE));
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
