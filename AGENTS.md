# AGENTS.md — opencode-mcp

MCP stdio server (TypeScript, ESM) exposing one tool, `ask_codebase`: read-only Q&A over GitHub repositories, answered by a headless `opencode` run inside a locally managed checkout.

## Commands

```bash
npm run typecheck   # tsc --noEmit — run after every change
npm run build       # emit dist/ (the shipped artifact)
npm test            # node:test on src/*.test.ts (runs .ts natively, no build)
```

## Architecture

One module per responsibility, all under `src/`, kebab-case filenames:

| Module | Responsibility |
| --- | --- |
| `index.ts` | Bootstrap: create `McpServer`, register the tool, connect stdio transport |
| `ask-codebase.ts` | Tool registration, input validation, opencode run + retry, output shaping |
| `get-repo.ts` | Deterministic clone/fetch/hard-resync (`ensureRepo`), fetch policy (`needsFetch`) |
| `manifest.ts` | JSON manifest of checkouts, atomic writes, mutex-guarded |
| `proc.ts` | Subprocess runner: hard timeout, 15 s heartbeat, abort-signal kill |
| `config.ts` | All env-driven configuration, resolved once at startup |
| `mutex.ts` | Minimal FIFO async mutex |
| `logger.ts` | Timestamped stderr logging |

Call flow: `ask_codebase` → `ensureRepo` (fetch lock → manifest → `getRepo` if the policy requires) → `run(opencode run …)` with `cwd` = checkout → truncated answer + notes.

## Hard invariants — do not break

- **stdout is the MCP protocol channel.** Never `console.log`; log via `logger.ts` (stderr) only.
- **The tool is READ-ONLY.** The prompt preamble in `buildPrompt` forbids writes; never add write/exec capabilities to the tool surface.
- **The manifest format is a shared contract.** Keys `dir`, `branch`, `fetched_at` (ISO 8601) under `owner/repo` — previous implementations wrote the same file; keep it compatible, keep writes atomic (tmp + rename).
- **Fetching is deterministic.** All user-facing fetch failures go through `GetRepoError` and are returned verbatim; never let raw exceptions leak to the client as generic errors.
- **Long subprocesses must heartbeat.** Any run that can exceed the client's timeout takes the `heartbeat` callback (progress every 15 s, no-op without a client `progressToken`).
- **Cancellation kills children.** Thread `extra.signal` into every `run()` call; an aborted request must never leave a git or opencode process behind.
- **Error results use `isError: true`** with the message as text content, so the calling LLM sees them.

## Conventions

- Strict TypeScript (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`); never weaken types to silence errors.
- ESM with `.ts` relative import specifiers, rewritten to `.js` at build time (`rewriteRelativeImportExtensions`). Node runs `src/` directly via type stripping (tests).
- SDK: `@modelcontextprotocol/sdk` v1.x (`McpServer.registerTool` + zod raw shapes). Do not migrate to the v2 SDK while it is pre-stable.
- No comments except `// tradeoff:`, `// debt:`, and TSDoc on shared/exported elements.
- Files stay well under 500 lines; split by responsibility instead of growing a module.
- Env var names (`OPENCODE_*`, `ASK_CODEBASE_TIMEOUT`) are public contract — renaming breaks deployments; document any addition in README.md.

## Testing rules

- Test pure logic only (validation, transformation, decisions): `needsFetch`, `normGitUrl`, `isValidRepoSlug`, `isValidBranch`, `truncate`.
- Test behavior, not implementation: never assert exact user-facing message wording; assert decisions and shapes.
- No tests that spawn git/opencode or the MCP transport.
- Test files live next to sources (`src/*.test.ts`) and are excluded from the build by `tsconfig.json`.
