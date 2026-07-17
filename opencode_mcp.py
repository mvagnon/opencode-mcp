# /// script
# requires-python = ">=3.11"
# dependencies = ["mcp>=1.2"]
# ///
"""
opencode_mcp — MCP server (stdio) for Hermes
============================================
Exposes an `ask_codebase` tool: ask a natural-language question about a GitHub
repository, get an answer grounded in the real code. READ-ONLY by design.

Architecture (serverless):
  1. The MCP itself fetches the repo (get-repo logic ported to Python): clone
     if absent, fetch + hard resync otherwise. Fully deterministic — a
     nonexistent repo fails in seconds with the git error relayed verbatim,
     zero LLM tokens spent.
  2. opencode runs HEADLESS with cwd = the repo directory. No `opencode serve`,
     no --attach. The repo's own AGENTS.md (if any) is loaded as project
     context. Sessions are opencode-native and scoped per project directory,
     so `--continue` deterministically means "the latest session of THIS repo"
     — cross-repo cross-talk is impossible by construction.

Fetch policy — get-repo runs only when needed:
  - the repo is not in the manifest, or
  - its checkout is missing on disk (periodic cleanup), or
  - an explicitly requested branch differs from the checked-out one, or
  - the last fetch is older than OPENCODE_REPO_TTL_DAYS (default 3).
  Otherwise the existing checkout is used as-is (stable code across calls).

Manifest (JSON, atomic writes):
  { "owner/repo": { "dir": "/abs/path", "branch": "main",
                    "fetched_at": "2026-07-15T03:21:00+00:00" } }
  Stored as .opencode_mcp_manifest.json in OPENCODE_MANIFEST_DIR (default ~).

Read-only enforcement: the codelab AGENTS.md is gone, so the guardrails are
(a) a read-only preamble injected into every prompt by this server, and
(b) your opencode agent config — define an "explore"-style agent with
`edit: deny` and set OPENCODE_AGENT to force it on every run. Do NOT put
read-only rules in your global AGENTS.md: it would poison your normal
interactive opencode sessions.

Long calls: hard timeout defaults to 10 minutes and an MCP progress
notification is emitted every 15s (clone/fetch included). Per the MCP spec,
clients that reset their request timeout on progress keep the call alive; when
the client sends no progressToken, report_progress is a no-op. Align Hermes's
own per-call timeout (`timeout:` in the mcp_servers entry) above the hard one.

Environment variables — declare them in the `env:` block of the Hermes
`mcp_servers` entry (Hermes does NOT pass your full shell env to stdio
servers, only PATH, HOME, USER, LANG, LC_ALL, TERM, SHELL, TMPDIR):

  OPENCODE_BIN            opencode binary. Default: opencode (ABSOLUTE path recommended).
  OPENCODE_AGENT          opencode agent for runs (e.g. "explore"). Default: none.
  OPENCODE_REPOS_DIR      Where checkouts live. Default: ~/codelab/repositories
  OPENCODE_MANIFEST_DIR   Directory of .opencode_mcp_manifest.json. Default: ~
  OPENCODE_REPO_TTL_DAYS  Re-fetch a repo after this many days. Default: 3
  ASK_CODEBASE_TIMEOUT    Hard timeout for the opencode run, seconds. Default: 600
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from mcp.server.fastmcp import Context, FastMCP

# --- logging: STDERR only (stdout is reserved for the MCP protocol) -----------
logging.basicConfig(
    level=logging.INFO,
    stream=sys.stderr,
    format="%(asctime)s opencode_mcp %(levelname)s %(message)s",
)
log = logging.getLogger("opencode_mcp")

# --- config -------------------------------------------------------------------
OPENCODE_BIN = os.environ.get("OPENCODE_BIN", "opencode")
AGENT = os.environ.get("OPENCODE_AGENT", "").strip()
REPOS_DIR = Path(
    os.environ.get("OPENCODE_REPOS_DIR") or Path.home() / "codelab" / "repositories"
).expanduser()
MANIFEST_DIR = Path(os.environ.get("OPENCODE_MANIFEST_DIR") or Path.home()).expanduser()
MANIFEST_FILE = MANIFEST_DIR / ".opencode_mcp_manifest.json"
TTL_SECONDS = float(os.environ.get("OPENCODE_REPO_TTL_DAYS", "3")) * 86_400
TIMEOUT = float(os.environ.get("ASK_CODEBASE_TIMEOUT", "600"))
FETCH_TIMEOUT = 300.0  # hard limit for a single clone/fetch
HEARTBEAT = 15.0  # seconds between MCP progress notifications (keep-alive)
MAX_OUTPUT = 12_000  # characters — protects the context / Discord

# owner: alphanumeric + single hyphens (GitHub rule) / repo: word chars . _ -
REPO_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?/[A-Za-z0-9._-]+$")
BRANCH_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$")

# Sentinel return codes for subprocess runners (never collide with real exits)
RC_NOBIN = -101
RC_TIMEOUT = -102

mcp = FastMCP("opencode-mcp")

TOOL_DESCRIPTION = (
    "Ask a natural-language question about a GitHub repository and get an answer grounded in "
    "the real code. READ-ONLY: never writes, edits, builds, or executes anything. The harness "
    "fetches the repo itself (clone or refresh, max every few days) — a nonexistent repo fails "
    "fast with the exact git error. Stateful PER REPOSITORY: continue_session=true resumes the "
    "latest discussion of that owner/repo (follow-up questions keep their context); false "
    "(default) starts a fresh one. Optional branch pins a specific branch. Use it for "
    "architecture questions, where a feature lives, request flow, conventions, design "
    "rationale, etc."
)


class GetRepoError(Exception):
    """User-facing fetch failure: message is returned to the caller verbatim."""


# --- manifest -------------------------------------------------------------------
_MANIFEST_LOCK = asyncio.Lock()
_FETCH_LOCK = asyncio.Lock()  # serializes clone/fetch + manifest update


def _load_manifest() -> dict[str, dict]:
    try:
        data = json.loads(MANIFEST_FILE.read_text("utf-8"))
        if isinstance(data, dict):
            return {
                str(k): v
                for k, v in data.items()
                if isinstance(v, dict) and isinstance(v.get("dir"), str)
            }
        log.warning("manifest %s is not a JSON object — starting empty", MANIFEST_FILE)
    except FileNotFoundError:
        pass
    except Exception as exc:  # noqa: BLE001 — corrupt manifest must not kill the tool
        log.warning("unreadable manifest %s (%s) — starting empty", MANIFEST_FILE, exc)
    return {}


def _save_manifest(manifest: dict[str, dict]) -> None:
    try:
        MANIFEST_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = MANIFEST_FILE.with_name(MANIFEST_FILE.name + ".tmp")
        tmp.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", "utf-8")
        tmp.replace(MANIFEST_FILE)  # atomic on POSIX
    except Exception as exc:  # noqa: BLE001
        log.warning("cannot write manifest %s (%s)", MANIFEST_FILE, exc)


async def _manifest_get(repo: str) -> dict | None:
    async with _MANIFEST_LOCK:
        return _load_manifest().get(repo)


async def _manifest_put(repo: str, entry: dict) -> None:
    async with _MANIFEST_LOCK:
        manifest = _load_manifest()
        manifest[repo] = entry
        _save_manifest(manifest)


def _needs_fetch(entry: dict | None, branch: str | None) -> tuple[bool, str]:
    """Decide whether get-repo must run. Returns (needed, reason)."""
    if not entry:
        return True, "not in manifest"
    d = entry.get("dir", "")
    if not d or not (Path(d) / ".git").is_dir():
        return True, "checkout missing on disk"
    if branch and entry.get("branch") != branch:
        return True, f"branch switch to '{branch}'"
    try:
        fetched = datetime.fromisoformat(str(entry.get("fetched_at", "")))
    except ValueError:
        return True, "invalid fetched_at"
    if fetched.tzinfo is None:
        fetched = fetched.replace(tzinfo=timezone.utc)
    age = datetime.now(timezone.utc) - fetched
    if age.total_seconds() > TTL_SECONDS:
        return True, f"stale (last fetch {age.days}d ago)"
    return False, ""


# --- subprocess runners -----------------------------------------------------------
async def _run(
    cmd: list[str], cwd: str | None = None, timeout: float = 60.0
) -> tuple[int, str, str]:
    """Plain runner for quick commands (no heartbeat)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=cwd,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=os.environ.copy(),
        )
    except FileNotFoundError:
        return RC_NOBIN, "", ""
    try:
        out_b, err_b = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return RC_TIMEOUT, "", ""
    return (
        proc.returncode or 0,
        (out_b or b"").decode("utf-8", "replace").strip(),
        (err_b or b"").decode("utf-8", "replace").strip(),
    )


async def _run_hb(
    cmd: list[str], cwd: str | None, timeout: float, ctx: Context
) -> tuple[int, str, str]:
    """Heartbeat runner for long commands (clone, fetch, opencode run).

    Emits an MCP progress notification every HEARTBEAT seconds. Returns
    (returncode, stdout, stderr); RC_NOBIN if the binary is missing,
    RC_TIMEOUT on hard timeout (stderr then carries any partial output).
    Kills the subprocess if the client cancels the request.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=cwd,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=os.environ.copy(),
        )
    except FileNotFoundError:
        return RC_NOBIN, "", ""

    comm = asyncio.create_task(proc.communicate())
    start = time.monotonic()

    try:
        while True:
            done, _pending = await asyncio.wait({comm}, timeout=HEARTBEAT)
            if comm in done:
                out_b, err_b = comm.result()
                break

            elapsed = time.monotonic() - start
            if elapsed >= timeout:
                proc.kill()
                partial = b""
                with contextlib.suppress(Exception):
                    partial, _ = await asyncio.wait_for(comm, timeout=5)
                return RC_TIMEOUT, "", partial.decode("utf-8", "replace").strip()[-800:]

            # No-op if the client sent no progressToken; clients that reset
            # their timeout on progress keep the call alive up to `timeout`.
            with contextlib.suppress(Exception):
                await ctx.report_progress(progress=min(elapsed, timeout), total=timeout)
    except asyncio.CancelledError:
        log.warning(
            "request cancelled by client after %.0fs — killing subprocess",
            time.monotonic() - start,
        )
        proc.kill()
        raise

    return (
        proc.returncode or 0,
        (out_b or b"").decode("utf-8", "replace").strip(),
        (err_b or b"").decode("utf-8", "replace").strip(),
    )


# --- get-repo, ported from bash -----------------------------------------------------
def _norm_git_url(url: str) -> str:
    url = url.strip()
    url = re.sub(r"^git@github\.com:", "github.com/", url)
    url = re.sub(r"^(ssh://git@|https?://)", "", url)
    url = re.sub(r"\.git$", "", url)
    return url.rstrip("/")


async def _get_repo(
    repo: str, wanted_branch: str | None, ctx: Context
) -> tuple[str, str, list[str]]:
    """Clone or hard-resync `repo`. Returns (abs_dir, checked_out_branch, warnings).

    Raises GetRepoError with a user-facing message (git output + hints) on
    fatal failure — nonexistent repo, missing branch, missing git binary.
    """
    org, name = repo.split("/", 1)
    name = name.removesuffix(".git")
    url = f"https://github.com/{org}/{name}.git"
    canon = f"github.com/{org}/{name}"
    warnings: list[str] = []

    REPOS_DIR.mkdir(parents=True, exist_ok=True)
    d = REPOS_DIR / name

    # URL-normalized collision check (ssh == https): same name, other owner
    if (d / ".git").is_dir():
        rc, out, _ = await _run(["git", "-C", str(d), "remote", "get-url", "origin"])
        if rc == 0 and _norm_git_url(out) != canon:
            d = REPOS_DIR / f"{org}--{name}"

    # Self-heal: leftover file or corrupted half-clone
    if d.exists():
        rc, *_ = await _run(["git", "-C", str(d), "rev-parse", "--git-dir"])
        if rc != 0:
            warnings.append(
                f"'{d.name}' existed but was not a valid git repo — re-cloned"
            )
            shutil.rmtree(d, ignore_errors=True)

    stale = False
    if not d.exists():
        log.info("cloning %s...", repo)
        rc, out, err = await _run_hb(
            ["git", "clone", "--quiet", "--filter=blob:none", url, str(d)],
            cwd=None,
            timeout=FETCH_TIMEOUT,
            ctx=ctx,
        )
        if rc == RC_NOBIN:
            raise GetRepoError("Error: `git` not found on the PATH passed to Hermes.")
        if rc == RC_TIMEOUT:
            shutil.rmtree(d, ignore_errors=True)
            raise GetRepoError(
                f"Error: clone of {repo} timed out after {FETCH_TIMEOUT:.0f}s."
            )
        if rc != 0:
            shutil.rmtree(d, ignore_errors=True)  # never leave a half-clone behind
            raise GetRepoError(
                f"get-repo ERROR: clone failed for {repo}\n{(err or out)[-600:]}\n"
                f"HINT: verify the identifier and its accessibility: gh repo view {repo}\n"
                f"HINT: if the repository is private, check credentials: gh auth status"
            )
    else:
        log.info("updating %s from origin...", repo)
        rc, out, err = await _run_hb(
            ["git", "-C", str(d), "fetch", "--quiet", "--prune", "origin"],
            cwd=None,
            timeout=FETCH_TIMEOUT,
            ctx=ctx,
        )
        if rc != 0:
            stale = True
            warnings.append(
                "fetch failed — using the existing local copy (it may be STALE)"
            )

    await _run(["git", "-C", str(d), "remote", "set-head", "origin", "--auto"])

    # Branch resolution: requested branch, else origin's default, else main
    rc, out, _ = await _run(
        [
            "git",
            "-C",
            str(d),
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ]
    )
    default = out.removeprefix("origin/") if rc == 0 and out else "main"

    branch = default
    if wanted_branch:
        rc, *_ = await _run(
            [
                "git",
                "-C",
                str(d),
                "rev-parse",
                "--quiet",
                "--verify",
                f"refs/remotes/origin/{wanted_branch}",
            ]
        )
        if rc == 0:
            branch = wanted_branch
        else:
            warnings.append(
                f"branch '{wanted_branch}' not found on origin — fell back to default '{default}'"
            )

    rc, *_ = await _run(
        [
            "git",
            "-C",
            str(d),
            "rev-parse",
            "--quiet",
            "--verify",
            f"refs/remotes/origin/{branch}",
        ]
    )
    if rc != 0:
        raise GetRepoError(
            f"get-repo ERROR: branch '{branch}' is unknown and could not be fetched\n"
            f"HINT: list remote branches: gh api repos/{repo}/branches --jq '.[].name'"
        )

    # Hard sync: local state == origin/<branch>, unconditionally
    rc, out, err = await _run(
        [
            "git",
            "-C",
            str(d),
            "checkout",
            "--quiet",
            "--force",
            "-B",
            branch,
            f"origin/{branch}",
        ],
        timeout=120,
    )
    if rc != 0:
        raise GetRepoError(f"get-repo ERROR: checkout failed\n{(err or out)[-400:]}")
    await _run(["git", "-C", str(d), "clean", "--quiet", "-fd"])

    if stale:
        warnings.append(
            f"checked out '{branch}' from the last fetched state (update failed)"
        )
    log.info("ready: %s @ %s", repo, branch)
    return str(d), branch, warnings


async def _ensure_repo(
    repo: str, branch: str | None, ctx: Context
) -> tuple[str, list[str]]:
    """Fetch the repo if the policy requires it; return (abs_dir, warnings)."""
    async with _FETCH_LOCK:
        entry = await _manifest_get(repo)
        needed, reason = _needs_fetch(entry, branch)
        if not needed:
            return entry["dir"], []  # type: ignore[index]
        log.info("fetching %s (%s)", repo, reason)
        d, actual_branch, warnings = await _get_repo(repo, branch, ctx)
        await _manifest_put(
            repo,
            {
                "dir": d,
                "branch": actual_branch,
                "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            },
        )
        return d, warnings


# --- tool -----------------------------------------------------------------------
def _build_prompt(question: str, repo: str) -> str:
    return (
        f"You are analyzing the repository {repo} in strict READ-ONLY mode: never edit or "
        f"create files, never run git write operations (add/commit/push/rebase/merge), never "
        f"build, install dependencies, or execute the project or its tests. Analysis only: "
        f"summaries, call graphs, design critiques, precise file/line references.\n\n"
        f"{question}"
    )


@mcp.tool(description=TOOL_DESCRIPTION)
async def ask_codebase(
    question: str,
    repo: str,
    ctx: Context,
    branch: str | None = None,
    continue_session: bool = False,
) -> str:
    """Query a repository and return an answer grounded in the real code (read-only).

    Args:
        question: The natural-language question (e.g. "where is API request auth validated?").
        repo: REQUIRED exact GitHub slug "owner/repo" (e.g. "vercel/next.js"). Deterministic —
            no nicknames, no fuzzy descriptions, no URLs. The harness fetches it itself and
            fails fast with the exact git error if it does not exist or is unreachable.
        branch: Optional branch to pin (e.g. "canary"). Omit for the repo's default branch.
            An explicit branch different from the current checkout triggers a re-fetch.
        continue_session: If true, resume the latest discussion of this repo (same context;
            the checkout is only refreshed by the TTL policy, so code usually stays stable).
            If false (default), start a fresh discussion.
    """
    question = (question or "").strip()
    if not question:
        return "Error: empty question."

    repo = (repo or "").strip()
    if not REPO_RE.match(repo):
        return (
            f"Error: repo must be an exact GitHub slug 'owner/repo' "
            f"(e.g. 'vercel/next.js'), got: {repo!r}"
        )

    branch = (branch or "").strip() or None
    if branch and (".." in branch or not BRANCH_RE.match(branch)):
        return f"Error: invalid branch name: {branch!r}"

    token = None
    with contextlib.suppress(Exception):
        token = (
            ctx.request_context.meta.progressToken if ctx.request_context.meta else None
        )
    log.info(
        "call repo=%s branch=%s continue=%s progressToken=%s",
        repo,
        branch or "(default)",
        continue_session,
        "yes" if token else "NO (client cannot extend its own timeout)",
    )

    # 1) Deterministic fetch (policy: missing / purged / branch switch / TTL)
    try:
        repo_dir, fetch_warnings = await _ensure_repo(repo, branch, ctx)
    except GetRepoError as exc:
        return str(exc)

    # 2) Headless opencode run inside the repo (loads the repo's own AGENTS.md)
    prompt = _build_prompt(question, repo)
    cmd = [OPENCODE_BIN, "run"]
    if AGENT:
        cmd += ["--agent", AGENT]
    if continue_session:
        cmd += ["--continue"]
    cmd.append(prompt)

    rc, out, err = await _run_hb(cmd, cwd=repo_dir, timeout=TIMEOUT, ctx=ctx)

    note = ""
    if rc > 0 and continue_session:
        # No resumable session in this repo dir (first call ever, purged
        # opencode storage, ...): self-heal once with a fresh session.
        log.warning("--continue failed for %s (exit %s) — retrying fresh", repo, rc)
        cmd = [c for c in cmd if c != "--continue"]
        rc, out, err = await _run_hb(cmd, cwd=repo_dir, timeout=TIMEOUT, ctx=ctx)
        note = "\n\n(note: no resumable discussion found for this repo — started a fresh one.)"

    if rc == RC_NOBIN:
        return (
            f"Error: binary '{OPENCODE_BIN}' not found. Make sure opencode is on the PATH "
            f"passed to Hermes, or set OPENCODE_BIN to an absolute path."
        )
    if rc == RC_TIMEOUT:
        msg = (
            f"Error: opencode timed out after {TIMEOUT:.0f}s (hard limit). "
            f"Raise ASK_CODEBASE_TIMEOUT or narrow the scope. The partial session is stored "
            f"by opencode: retry with continue_session=true and a narrower question."
        )
        if err:
            msg += f"\nPartial output:\n{err}"
        return msg
    if rc != 0:
        tail = (err or out)[-800:]
        return f"opencode error (exit {rc}):\n{tail or '(no output)'}"

    if not out:
        out = "(opencode returned nothing)"
    elif len(out) > MAX_OUTPUT:
        out = out[:MAX_OUTPUT] + "\n\n[…output truncated…]"

    if fetch_warnings:
        note += "\n\n(fetch notes: " + " · ".join(fetch_warnings) + ")"
    return out + note


if __name__ == "__main__":
    log.info(
        "starting — bin=%s agent=%s repos=%s manifest=%s ttl=%.1fd hard_timeout=%.0fs",
        OPENCODE_BIN,
        AGENT or "(default)",
        REPOS_DIR,
        MANIFEST_FILE,
        TTL_SECONDS / 86_400,
        TIMEOUT,
    )
    mcp.run()  # stdio by default
