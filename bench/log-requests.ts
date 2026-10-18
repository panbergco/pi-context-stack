// Bench-only pi extension: append every provider request payload to $PI_BENCH_REQLOG (one JSON line each),
// so bench/anthropic-sim.mjs can replay the exact prefixes against Anthropic's caching rules.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";

export default function logRequests(pi: ExtensionAPI) {
  const file = process.env.PI_BENCH_REQLOG;
  if (!file) return;
  pi.on("before_provider_request", (event: any) => {
    appendFileSync(file, JSON.stringify({ t: Date.now(), payload: event.payload }) + "\n");
  });
}
