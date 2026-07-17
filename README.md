# opencode-mcp

MCP server (stdio) exposing an `ask_codebase` tool: ask a natural-language question about a GitHub repository, get an answer grounded in the real code. **READ-ONLY by design.**

Built in TypeScript on the official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), and on [opencode](https://opencode.ai) running headless as the analysis engine.

## How it works

1. **The server fetches the repo itself** — clone if absent, fetch + hard resync otherwise. Fully deterministic: a nonexistent repo fails in seconds with the git error relayed verbatim, zero LLM tokens spent.
2. **opencode runs headless** with `cwd` = the repo directory. No `opencode serve`, no `--attach`. The repo's own `AGENTS.md` (if any) is loaded as project context. Sessions are opencode-native and scoped per project directory, so `continue_session=true` deterministically means "the latest session of *this* repo" — cross-repo cross-talk is impossible by construction.

### Fetch policy

A clone/fetch runs only when:

- the repo is not in the manifest, or
- its checkout is missing on disk (periodic cleanup), or
- an explicitly requested branch differs from the checked-out one, or
- the last fetch is older than `OPENCODE_REPO_TTL_DAYS` (default 3).

Otherwise the existing checkout is used as-is, so the code stays stable across follow-up calls.

### Manifest

Known checkouts are tracked in `.opencode_mcp_manifest.json` (atomic writes, one entry per `owner/repo`):

```json
{
  "owner/repo": {
    "dir": "/abs/path",
    "branch": "main",
    "fetched_at": "2026-07-15T03:21:00Z"
  }
}
```

### Read-only enforcement

Two layers:

1. A read-only preamble injected into every prompt by this server.
2. Your opencode agent config — define an "explore"-style agent with `edit: deny` and set `OPENCODE_AGENT` to force it on every run.

Do **not** put read-only rules in your global `AGENTS.md`: it would poison your normal interactive opencode sessions.

### Long calls

The hard timeout defaults to 10 minutes and an MCP progress notification is emitted every 15 s (clone/fetch included). Per the MCP spec, clients that reset their request timeout on progress keep the call alive; when the client sends no `progressToken`, the heartbeat is a no-op. Align the client's own per-call timeout (`timeout:` in the `mcp_servers` entry) above the hard one.

## Requirements

- Node.js ≥ 20
- `git` on the PATH
- [opencode](https://opencode.ai) CLI (absolute path recommended via `OPENCODE_BIN`)

## Install

From npm:

```bash
npm install -g @mvagnon/opencode-mcp   # installs the `opencode-mcp` command
```

Or run it without installing:

```bash
npx -y @mvagnon/opencode-mcp
```

From source:

```bash
npm install
npm run build   # server binary: dist/index.js (stdio transport)
```

## Configuration

Declare environment variables in the `env:` block of the client's `mcp_servers` entry. Hermes does **not** pass your full shell env to stdio servers — only `PATH`, `HOME`, `USER`, `LANG`, `LC_ALL`, `TERM`, `SHELL`, `TMPDIR`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENCODE_BIN` | `opencode` | opencode binary (absolute path recommended) |
| `OPENCODE_AGENT` | *(none)* | opencode agent forced on every run (e.g. `explore`) |
| `OPENCODE_REPOS_DIR` | `~/codelab/repositories` | Where checkouts live |
| `OPENCODE_MANIFEST_DIR` | `~` | Directory of `.opencode_mcp_manifest.json` |
| `OPENCODE_REPO_TTL_DAYS` | `3` | Re-fetch a repo after this many days |
| `ASK_CODEBASE_TIMEOUT` | `600` | Hard timeout for the opencode run, in seconds |

Example client entry (Hermes):

```yaml
mcp_servers:
  opencode:
    command: npx
    args: ["-y", "@mvagnon/opencode-mcp"]
    timeout: 660 # keep above ASK_CODEBASE_TIMEOUT
    env:
      OPENCODE_BIN: /usr/local/bin/opencode
      OPENCODE_AGENT: explore
```

For a from-source checkout, use `command: node` with `args: ["/abs/path/to/opencode-mcp/dist/index.js"]` instead.

## The `ask_codebase` tool

| Argument | Type | Description |
| --- | --- | --- |
| `question` | `string` | The natural-language question (e.g. "where is API request auth validated?") |
| `repo` | `string` | Exact GitHub slug `owner/repo` — no nicknames, no URLs |
| `branch` | `string?` | Optional branch to pin; omit for the default branch |
| `continue_session` | `boolean` | Resume the latest discussion of this repo (default `false`) |

Use it for architecture questions, where a feature lives, request flow, conventions, design rationale, etc.

## Development

```bash
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm run build       # emit dist/
npm test            # node:test unit tests (pure logic)
npm run dev         # tsc --watch
```

Source layout: see [AGENTS.md](AGENTS.md).

## Releasing

Releases are fully automated with [release-please](https://github.com/googleapis/release-please) and npm [trusted publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC — no npm token stored in the repo):

1. Land changes on `main` using [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`, `feat!:`…) — they drive the version bump and the changelog.
2. release-please maintains a release PR that accumulates changes, bumps `package.json`, and updates `CHANGELOG.md`.
3. Merging the release PR creates the GitHub release and tag; the `publish` job then publishes to npm via OIDC.

One-time setup (already done once the package exists):

- npm cannot create a package via OIDC, so the **first version must be published manually** (`npm login && npm publish`).
- Then on npmjs.com → package → Settings → **Trusted Publisher**: GitHub Actions, repository `mvagnon/opencode-mcp`, workflow `release.yml`.
