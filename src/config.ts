import os from "node:os";
import path from "node:path";
import { log } from "./logger.ts";

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function numberEnv(name: string, fallback: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (Number.isFinite(value)) return value;
  log.warn(`invalid ${name}=${JSON.stringify(raw)} — using default ${fallback}`);
  return fallback;
}

/** opencode binary. Absolute path recommended. */
export const OPENCODE_BIN = env("OPENCODE_BIN") || "opencode";
/** opencode agent forced on every run (e.g. "explore"). Empty = opencode default. */
export const AGENT = env("OPENCODE_AGENT");
/** Where repository checkouts live. */
export const REPOS_DIR = expandHome(
  env("OPENCODE_REPOS_DIR") || path.join(os.homedir(), "codelab", "repositories"),
);
/** Manifest of known checkouts, shared with any other writer — keep the format stable. */
export const MANIFEST_FILE = path.join(
  expandHome(env("OPENCODE_MANIFEST_DIR") || os.homedir()),
  ".opencode_mcp_manifest.json",
);
/** Re-fetch a repo after this age. */
export const TTL_MS = numberEnv("OPENCODE_REPO_TTL_DAYS", 3) * 86_400_000;
/** Hard timeout for one opencode run. */
export const RUN_TIMEOUT_MS = numberEnv("ASK_CODEBASE_TIMEOUT", 600) * 1000;
/** Hard limit for a single clone/fetch. */
export const FETCH_TIMEOUT_MS = 300_000;
/** Default timeout for quick git commands. */
export const QUICK_TIMEOUT_MS = 60_000;
/** Interval between MCP progress notifications (keep-alive for long calls). */
export const HEARTBEAT_MS = 15_000;
/** Max characters returned to the client — protects the caller's context. */
export const MAX_OUTPUT = 12_000;
