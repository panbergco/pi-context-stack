// Pure core of pi-context-stack: no pi imports, so it is testable on its own.
//
// The live context sent to the model is a PROJECTION of the full session:
//
//   [ head: the task (first user message) or everything up to an anchor ]  <- byte-identical, cached
//   [ S1 ] [ S2 ] ... [ Sk ]                                              <- appended, never refolded
//   [ kept: the newest `keep` share of what checkpoint k cut, verbatim ]
//   [ everything since ]                                                  <- the live tail
//
// Nothing is deleted from the session file: each summary's originals stay retrievable, verbatim, through
// the recall tool, and switching the stack off restores the full history.

export interface Checkpoint {
  /** 1-based position in the stack. */
  k: number;
  /** The summary text, written by the model on its own cached context. */
  summary: string;
  /** Timestamp of the last message the summary covers; after it, messages stay verbatim. */
  cutTs: number;
  /** Timestamp of the last message before this span (the previous cut, or the end of the head). */
  fromTs?: number;
  /** Timestamp of the model's summary reply (control traffic, never shown). Absent in v0.1: = cutTs. */
  replyTs?: number;
  /** When the checkpoint was taken; also the summary message's timestamp, so its bytes never change. */
  takenAt: number;
  /** Estimated tokens of the span it replaced, and of the summary itself. */
  spanTokens?: number;
  summaryTokens?: number;
}

export interface Settings {
  enabled: boolean;
  /** Checkpoint when the live tail reaches this: tokens ("100k") or a share of the context window ("10%"). */
  every: string | number | null;
  /** Share of the tail since the last checkpoint kept verbatim at each checkpoint (0..0.9). */
  keep: number;
  /** Target summary length as a share of the span it replaces (5% of 100k -> about 5k tokens). */
  density: number;
  /** Take a checkpoint instead of pi's threshold compaction. Off = pi (or another extension) keeps its compaction. */
  replaceCompaction: boolean;
}

export interface StackState extends Settings {
  /** Timestamp of the last message kept verbatim before the stack (null = the first user message). */
  anchorTs: number | null;
  checkpoints: Checkpoint[];
}

export interface MessageLike {
  role: string;
  timestamp?: number;
  content?: unknown;
  customType?: string;
}

export const SUMMARY_TYPE = "context-stack:summary";
export const PROMPT_TYPE = "context-stack:summary-request";
export const RESUME_TYPE = "context-stack:resume";
export const NUDGE_TYPE = "context-stack:nudge";
export const SUMMARY_MARKER = "[context-stack checkpoint summary]";
export const RECALL_TOOL = "context_stack_recall";

export const DEFAULTS: Settings = { enabled: true, every: "10%", keep: 0, density: 0.05, replaceCompaction: true };

export const emptyState = (): StackState => ({ ...DEFAULTS, enabled: false, anchorTs: null, checkpoints: [] });

/**
 * Closes every summary message, so the request right after a checkpoint can END at Sk and pi's
 * last-message cache breakpoint writes [head..Sk]. Fixed text: the bytes of Sk never change.
 */
export const RESUME_LINE =
  `[context-stack] Everything before this point is summarised above; ${RECALL_TOOL} returns any summary's originals verbatim. ` +
  "Messages after this point are verbatim. If the task is not complete, continue it, working exactly as before; do not stop until it is complete.";

/** "100k", "1.5m", "80000" -> tokens; "off", "0", "" -> null; anything else -> undefined (invalid). */
export function parseTokens(v: unknown): number | null | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim().toLowerCase();
  if (s === "" || s === "off" || s === "0") return null;
  const m = s.match(/^(\d+(?:\.\d+)?)([km]?)$/);
  if (!m) return undefined;
  return Math.round(Number(m[1]) * (m[2] === "m" ? 1e6 : m[2] === "k" ? 1e3 : 1));
}

/** "5%", "0.05", 0.05 -> 0.05. undefined when invalid. */
export function parseShare(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const s = String(v).trim();
  const n = s.endsWith("%") ? Number(s.slice(0, -1)) / 100 : Number(s);
  return Number.isFinite(n) && n >= 0 && n < 1 ? n : undefined;
}

/** `every` as given ("10%", "100k", 100000, "off") -> a valid spec, null (off) or undefined (invalid). */
export function parseEvery(v: unknown): string | number | null | undefined {
  if (typeof v === "string" && v.trim().endsWith("%")) {
    const s = parseShare(v);
    return s ? `${+(s * 100).toFixed(4)}%` : s === 0 ? null : undefined;
  }
  return parseTokens(v);
}

/** The `every` spec in tokens for a given context window. */
export function everyTokens(every: string | number | null, contextWindow: number | undefined): number | null {
  if (every === null) return null;
  if (typeof every === "number") return every;
  if (every.endsWith("%")) return contextWindow ? Math.round((Number(every.slice(0, -1)) / 100) * contextWindow) : null;
  return parseTokens(every) ?? null;
}

export function estimateTokens(messages: (MessageLike | undefined)[]): number {
  let chars = 0;
  for (const m of messages) if (m) chars += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length;
  return Math.ceil(chars / 4); // ponytail: chars/4, same order as pi's estimate; provider usage if triggers drift
}

/** Index of the last head message (-1 = none). */
function headEnd(messages: MessageLike[], s: StackState): number {
  return s.anchorTs !== null ? messages.findIndex((m) => m.timestamp === s.anchorTs) : messages.findIndex((m) => m.role === "user");
}

/** Control traffic of past checkpoints: summary requests that were answered and the answers themselves. */
function hidden(s: StackState) {
  const replies = new Set(s.checkpoints.map((c) => c.replyTs ?? c.cutTs));
  const lastReply = s.checkpoints.length ? Math.max(...s.checkpoints.map((c) => c.replyTs ?? c.cutTs)) : -Infinity;
  return (m: MessageLike) =>
    m.customType === SUMMARY_TYPE || m.customType === RESUME_TYPE ||
    (m.customType === PROMPT_TYPE && (m.timestamp ?? 0) <= lastReply) ||
    (m.role === "assistant" && replies.has(m.timestamp ?? NaN));
}

/** The verbatim messages after the last cut (what the next checkpoint works on). */
export function liveTail<M extends MessageLike>(messages: M[], s: StackState): M[] {
  const h = headEnd(messages, s);
  const after = s.checkpoints.at(-1)?.cutTs ?? -Infinity;
  const isHidden = hidden(s);
  return messages.slice(h + 1).filter((m) => (m.timestamp ?? 0) > after && !isHidden(m));
}

/** Estimated tokens of the live tail, without a pending summary request. */
export function tailTokens(messages: MessageLike[], s: StackState): number {
  return estimateTokens(liveTail(messages, s).filter((m) => m.customType !== PROMPT_TYPE));
}

/** The summary message for checkpoint k: fixed text and timestamp, so its bytes never change once written. */
export function summaryMessage(c: Checkpoint) {
  return {
    role: "custom" as const,
    customType: SUMMARY_TYPE,
    content: `${SUMMARY_MARKER} ${c.k}\n\n${c.summary}\n\n${RESUME_LINE}`,
    display: false,
    details: { k: c.k, cutTs: c.cutTs },
    timestamp: c.takenAt,
  };
}

/**
 * Project the full message list onto the live context. Returns null when nothing should change
 * (stack off, no checkpoints, or the anchor cannot be found: fail open, never drop history blindly).
 */
export function project<M extends MessageLike>(messages: M[], s: StackState): (M | ReturnType<typeof summaryMessage>)[] | null {
  if (!s.enabled || s.checkpoints.length === 0) return null;
  const h = headEnd(messages, s);
  if (h < 0 && s.anchorTs !== null) return null;
  return [...messages.slice(0, h + 1), ...s.checkpoints.map(summaryMessage), ...liveTail(messages, s)];
}

export interface Cut {
  /** The span the next summary replaces, and the newest part that stays verbatim. */
  span: MessageLike[];
  kept: MessageLike[];
  cutTs: number;
  fromTs: number;
  spanTokens: number;
}

/**
 * Where the next checkpoint cuts: keep the newest `keep` share of the live tail verbatim. Never starts the
 * kept part on a tool result (its call would be summarised away). null when there is nothing to summarise.
 */
export function chooseCut(messages: MessageLike[], s: StackState): Cut | null {
  const tail = liveTail(messages, s).filter((m) => m.customType !== PROMPT_TYPE && m.timestamp !== undefined);
  if (tail.length === 0) return null;
  const sizes = tail.map((m) => estimateTokens([m]));
  const budget = s.keep * sizes.reduce((a, b) => a + b, 0);
  let i = tail.length;
  for (let kept = 0; i > 0 && kept + sizes[i - 1] <= budget; i--) kept += sizes[i - 1];
  while (i < tail.length && tail[i].role === "toolResult") i++;
  if (i === 0) { i = 1; while (i < tail.length && tail[i].role === "toolResult") i++; }
  const span = tail.slice(0, i);
  const h = headEnd(messages, s);
  const fromTs = s.checkpoints.at(-1)?.cutTs ?? (h >= 0 ? messages[h].timestamp ?? 0 : -Infinity);
  return { span, kept: tail.slice(i), cutTs: span.at(-1)!.timestamp!, fromTs, spanTokens: sizes.slice(0, i).reduce((a, b) => a + b, 0) };
}

/** The messages checkpoint k replaced, verbatim, from the full session. */
export function spanOf<M extends MessageLike>(messages: M[], s: StackState, k: number): M[] {
  const c = s.checkpoints[k - 1];
  if (!c) return [];
  const prev = s.checkpoints[k - 2];
  const h = headEnd(messages, s);
  const from = c.fromTs ?? prev?.cutTs ?? (h >= 0 ? messages[h].timestamp ?? 0 : -Infinity);
  const isHidden = hidden(s);
  return messages.filter((m) => (m.timestamp ?? 0) > from && (m.timestamp ?? 0) <= c.cutTs && !isHidden(m) && m.customType !== PROMPT_TYPE && m.customType !== NUDGE_TYPE);
}

/** Plain-text rendering of messages for the recall tool: text, tool calls and tool results, verbatim. */
export function render(messages: MessageLike[]): string {
  const out: string[] = [];
  for (const m of messages) {
    out.push(`## ${m.role}${m.timestamp ? " · " + new Date(m.timestamp).toISOString() : ""}`);
    if (typeof m.content === "string") out.push(m.content);
    else if (Array.isArray(m.content)) {
      for (const c of m.content as any[]) {
        if (c?.type === "text") out.push(c.text ?? "");
        else if (c?.type === "toolCall") out.push(`[tool call ${c.name}] ${JSON.stringify(c.arguments ?? {})}`);
        else if (c?.type === "image") out.push("[image]");
      }
    }
    out.push("");
  }
  return out.join("\n");
}

/** The text a message carries. */
export function textOf(m: MessageLike): string {
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  return m.content
    .filter((c: { type?: string }) => c?.type === "text")
    .map((c: { text?: string }) => c.text ?? "")
    .join("\n")
    .trim();
}

/** Timestamp of the message that ends the exchange begun by the user message containing `needle`. */
export function anchorFor(messages: MessageLike[], needle: string): number | null {
  const start = messages.findIndex((m) => m.role === "user" && textOf(m).includes(needle));
  if (start < 0) return null;
  let end = start;
  for (let i = start + 1; i < messages.length && messages[i].role !== "user"; i++) end = i;
  return messages[end].timestamp ?? null;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

/** The summary request for one cut, with the length the density setting asks for. */
export function summaryPrompt(cut: Cut, density: number): string {
  const target = Math.max(200, Math.round(cut.spanTokens * density));
  const first = cut.kept[0];
  const scope = first
    ? `Summarise ONLY the messages BEFORE the ${first.role} message that begins "${clip(textOf(first).replace(/\s+/g, " "), 80) || "(tool call)"}". ` +
      `That message and everything after it stay in your context verbatim; do not summarise them.`
    : "Summarise everything since the last checkpoint (or since the task, for the first one).";
  return `${SUMMARY_MARKER}
Write a checkpoint summary. ${scope}
It REPLACES that span in your live context. Its originals stay retrievable verbatim with ${RECALL_TOOL}, but only what you write here stays in view.
Carry, precisely: the goal; decisions and why; files, commands, ids and numbers that matter; what is done;
what is in flight and its exact next step, stated as the next ACTION (tool call) to take; open questions.
Length: about ${target} tokens (~${Math.round(target * 0.75)} words), the share of the span the density setting asks for. Plain markdown.
Reply with the summary only.`;
}

/**
 * Anthropic-style payloads (pi set `cache_control`): put a breakpoint at the end of the newest summary, so
 * the next checkpoint reads [head..Sk] from cache even when kept messages follow Sk. Anthropic allows 4;
 * pi uses up to 4 (tools, 1-2 system, last message); when full, the first system block's (the fixed
 * identity line, covered by the next system block's entry) is moved. Returns the payload, changed or not.
 */
export function placeSummaryBreakpoint(payload: any, k: number): any {
  if (!payload || !Array.isArray(payload.messages) || !JSON.stringify(payload).includes('"cache_control"')) return payload;
  const marker = `${SUMMARY_MARKER} ${k}`;
  let target: any = null;
  for (const m of payload.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) if (b?.type === "text" && typeof b.text === "string" && b.text.startsWith(marker)) target = b;
  }
  if (!target || target.cache_control) return payload;
  const holders: any[] = [];
  for (const t of payload.tools ?? []) if (t?.cache_control) holders.push(t);
  const sys = Array.isArray(payload.system) ? payload.system : [];
  const sysHolders = sys.filter((b: any) => b?.cache_control);
  holders.push(...sysHolders);
  for (const m of payload.messages) if (Array.isArray(m.content)) for (const b of m.content) if (b?.cache_control) holders.push(b);
  if (holders.length >= 4) {
    if (sysHolders.length < 2) return payload; // nothing redundant to move: leave pi's placement alone
    const ttl = sysHolders[0].cache_control;
    delete sysHolders[0].cache_control;
    target.cache_control = ttl;
    return payload;
  }
  target.cache_control = sysHolders[0]?.cache_control ?? holders[0]?.cache_control ?? { type: "ephemeral" };
  return payload;
}
