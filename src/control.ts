// Per-process control socket, so a CLI (or an orchestrator, or cron) can drive any running pi session.
//
//   <dir>/<pid>.sock   one JSON line in ({ op, ... }), one JSON line out ({ ok, status } | { ok:false, error })
//   <dir>/<pid>.json   who this is: pid, session id, cwd, tmux pane, so the CLI can find it by any of them
//
// <dir> = $PI_CONTEXT_STACK_DIR or ~/.pi/context-stack. Same user only (mode 0700 dir, 0600 socket).
import { createServer, type Server } from "node:net";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const controlDir = () => process.env.PI_CONTEXT_STACK_DIR ?? join(homedir(), ".pi", "context-stack");

export type Handler = (req: Record<string, unknown>) => Promise<unknown> | unknown;

export function startControl(info: Record<string, unknown>, handle: Handler): () => void {
  const dir = controlDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sock = join(dir, `${process.pid}.sock`);
  const meta = join(dir, `${process.pid}.json`);
  rmSync(sock, { force: true }); // a previous runtime in this process (reload) or a dead one with our pid
  const server: Server = createServer((c) => {
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", async (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let out: unknown;
      try { out = { ok: true, status: await handle(JSON.parse(buf.slice(0, nl))) }; }
      catch (e) { out = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
      c.end(JSON.stringify(out) + "\n");
    });
    c.on("error", () => {});
  });
  server.on("error", () => {}); // never take pi down over the control channel
  server.listen(sock, () => { try { chmodSync(sock, 0o600); } catch {} });
  writeFileSync(meta, JSON.stringify({ ...info, pid: process.pid, socket: sock, startedAt: Date.now() }) + "\n", { mode: 0o600 });
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    server.close();
    rmSync(sock, { force: true });
    rmSync(meta, { force: true });
  };
}
