import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AGENT, MAX_OUTPUT, OPENCODE_BIN, RUN_TIMEOUT_MS } from "./config.ts";
import { ensureRepo, GetRepoError } from "./get-repo.ts";
import { log } from "./logger.ts";
import { run, type Heartbeat, type ProcResult } from "./proc.ts";

const TOOL_DESCRIPTION =
  "Ask a natural-language question about a GitHub repository and get an answer grounded in " +
  "the real code. READ-ONLY: never writes, edits, builds, or executes anything. The harness " +
  "fetches the repo itself (clone or refresh, max every few days) — a nonexistent repo fails " +
  "fast with the exact git error. Stateful PER REPOSITORY: continue_session=true resumes the " +
  "latest discussion of that owner/repo (follow-up questions keep their context); false " +
  "(default) starts a fresh one. Optional branch pins a specific branch. Use it for " +
  "architecture questions, where a feature lives, request flow, conventions, design " +
  "rationale, etc.";

// owner: alphanumeric + hyphens, no leading/trailing hyphen (GitHub rule) / repo: word chars . _ -
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;

export function isValidRepoSlug(repo: string): boolean {
  return REPO_RE.test(repo);
}

export function isValidBranch(branch: string): boolean {
  return !branch.includes("..") && BRANCH_RE.test(branch);
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n\n[…output truncated…]` : text;
}

function buildPrompt(question: string, repo: string): string {
  return (
    `You are analyzing the repository ${repo} in strict READ-ONLY mode: never edit or ` +
    `create files, never run git write operations (add/commit/push/rebase/merge), never ` +
    `build, install dependencies, or execute the project or its tests. Analysis only: ` +
    `summaries, call graphs, design critiques, precise file/line references.\n\n${question}`
  );
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export function registerAskCodebase(server: McpServer): void {
  server.registerTool(
    "ask_codebase",
    {
      title: "Ask codebase",
      description: TOOL_DESCRIPTION,
      inputSchema: {
        question: z
          .string()
          .describe('The natural-language question (e.g. "where is API request auth validated?").'),
        repo: z
          .string()
          .describe(
            'REQUIRED exact GitHub slug "owner/repo" (e.g. "vercel/next.js"). Deterministic — ' +
              "no nicknames, no fuzzy descriptions, no URLs. The harness fetches it itself and " +
              "fails fast with the exact git error if it does not exist or is unreachable.",
          ),
        branch: z
          .string()
          .optional()
          .describe(
            'Optional branch to pin (e.g. "canary"). Omit for the repo\'s default branch. An ' +
              "explicit branch different from the current checkout triggers a re-fetch.",
          ),
        continue_session: z
          .boolean()
          .default(false)
          .describe(
            "If true, resume the latest discussion of this repo (same context; the checkout is " +
              "only refreshed by the TTL policy, so code usually stays stable). If false " +
              "(default), start a fresh discussion.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, extra) => {
      const question = args.question.trim();
      if (!question) return errorResult("Error: empty question.");

      const repo = args.repo.trim();
      if (!isValidRepoSlug(repo)) {
        return errorResult(
          `Error: repo must be an exact GitHub slug 'owner/repo' ` +
            `(e.g. 'vercel/next.js'), got: ${JSON.stringify(args.repo)}`,
        );
      }

      const branch = args.branch?.trim() || undefined;
      if (branch && !isValidBranch(branch)) {
        return errorResult(`Error: invalid branch name: ${JSON.stringify(branch)}`);
      }

      const progressToken = extra._meta?.progressToken;
      log.info(
        `call repo=${repo} branch=${branch ?? "(default)"} continue=${args.continue_session} ` +
          `progressToken=${progressToken !== undefined ? "yes" : "NO (client cannot extend its own timeout)"}`,
      );

      // No-op if the client sent no progressToken; clients that reset their
      // timeout on progress keep the call alive up to the hard timeout.
      const heartbeat: Heartbeat = async (elapsedMs, totalMs) => {
        if (progressToken === undefined) return;
        await extra.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: Math.min(elapsedMs, totalMs) / 1000,
            total: totalMs / 1000,
          },
        });
      };

      // 1) Deterministic fetch (policy: missing / purged / branch switch / TTL)
      let repoDir: string;
      let fetchWarnings: string[];
      try {
        ({ dir: repoDir, warnings: fetchWarnings } = await ensureRepo(
          repo,
          branch,
          heartbeat,
          extra.signal,
        ));
      } catch (err) {
        if (err instanceof GetRepoError) return errorResult(err.message);
        throw err;
      }

      // 2) Headless opencode run inside the repo (loads the repo's own AGENTS.md)
      const prompt = buildPrompt(question, repo);
      const opencode = (withContinue: boolean): Promise<ProcResult> => {
        const flags: string[] = [];
        if (AGENT) flags.push("--agent", AGENT);
        if (withContinue) flags.push("--continue");
        return run([OPENCODE_BIN, "run", ...flags, prompt], {
          cwd: repoDir,
          timeoutMs: RUN_TIMEOUT_MS,
          heartbeat,
          signal: extra.signal,
        });
      };

      let res = await opencode(args.continue_session);

      let note = "";
      if (res.kind === "exit" && res.code !== null && res.code > 0 && args.continue_session) {
        // No resumable session in this repo dir (first call ever, purged
        // opencode storage, ...): self-heal once with a fresh session.
        log.warn(`--continue failed for ${repo} (exit ${res.code}) — retrying fresh`);
        res = await opencode(false);
        note = "\n\n(note: no resumable discussion found for this repo — started a fresh one.)";
      }

      if (res.kind === "nobin") {
        return errorResult(
          `Error: binary '${OPENCODE_BIN}' not found. Make sure opencode is on the PATH ` +
            `passed to Hermes, or set OPENCODE_BIN to an absolute path.`,
        );
      }
      if (res.kind === "timeout") {
        let msg =
          `Error: opencode timed out after ${RUN_TIMEOUT_MS / 1000}s (hard limit). ` +
          `Raise ASK_CODEBASE_TIMEOUT or narrow the scope. The partial session is stored ` +
          `by opencode: retry with continue_session=true and a narrower question.`;
        if (res.partial) msg += `\nPartial output:\n${res.partial}`;
        return errorResult(msg);
      }
      if (res.code !== 0) {
        const tail = (res.stderr || res.stdout).slice(-800);
        const exit = res.code ?? `signal ${res.signal}`;
        return errorResult(`opencode error (exit ${exit}):\n${tail || "(no output)"}`);
      }

      const out = truncate(res.stdout || "(opencode returned nothing)", MAX_OUTPUT);
      if (fetchWarnings.length > 0) {
        note += `\n\n(fetch notes: ${fetchWarnings.join(" · ")})`;
      }
      return textResult(out + note);
    },
  );
}
