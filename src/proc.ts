import { spawn } from "node:child_process";
import { HEARTBEAT_MS } from "./config.ts";

/**
 * Outcome of a subprocess run.
 * - `exit`: the process ran to completion (code 0 = success, null = killed by a signal).
 * - `nobin`: the binary was not found on PATH.
 * - `timeout`: the hard timeout killed the process; `partial` carries the tail of its stdout.
 */
export type ProcResult =
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
  | { kind: "nobin" }
  | { kind: "timeout"; partial: string };

/** Called every HEARTBEAT_MS while a process runs; errors are swallowed. */
export type Heartbeat = (elapsedMs: number, totalMs: number) => Promise<void>;

export interface RunOptions {
  timeoutMs: number;
  cwd?: string;
  /** Emit MCP progress notifications during long runs (clone, fetch, opencode). */
  heartbeat?: Heartbeat;
  /** Client-side cancellation: kills the process and rejects with the abort reason. */
  signal?: AbortSignal;
}

export function run(cmd: readonly [string, ...string[]], opts: RunOptions): Promise<ProcResult> {
  const [bin, ...args] = cmd;

  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(abortError(opts.signal));
      return;
    }

    const child = spawn(bin, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));

    const started = Date.now();
    let settled = false;
    let timedOut = false;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);

    const heartbeatTimer = opts.heartbeat
      ? setInterval(() => {
          void opts.heartbeat?.(Date.now() - started, opts.timeoutMs).catch(() => undefined);
        }, HEARTBEAT_MS)
      : undefined;

    const onAbort = (): void => {
      child.kill("SIGKILL");
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (outcome: ProcResult | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };

    child.once("error", (err: NodeJS.ErrnoException) => {
      finish(err.code === "ENOENT" ? { kind: "nobin" } : err);
    });

    child.once("close", (code, signal) => {
      if (opts.signal?.aborted) finish(abortError(opts.signal));
      else if (timedOut) finish({ kind: "timeout", partial: stdout.trim().slice(-800) });
      else finish({ kind: "exit", code, signal, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("request cancelled by client");
}
