import { statSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { FETCH_TIMEOUT_MS, QUICK_TIMEOUT_MS, REPOS_DIR, TTL_MS } from "./config.ts";
import { log } from "./logger.ts";
import { manifestGet, manifestPut, type ManifestEntry } from "./manifest.ts";
import { Mutex } from "./mutex.ts";
import { run, type Heartbeat, type RunOptions } from "./proc.ts";

/** User-facing fetch failure: message is returned to the caller verbatim. */
export class GetRepoError extends Error {}

export interface RepoCheckout {
  dir: string;
  branch: string;
  warnings: string[];
}

export interface FetchDecision {
  needed: boolean;
  reason: string;
}

const fetchLock = new Mutex(); // serializes clone/fetch + manifest update

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function normGitUrl(url: string): string {
  return url
    .trim()
    .replace(/^git@github\.com:/, "github.com/")
    .replace(/^(ssh:\/\/git@|https?:\/\/)/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
}

/** Decide whether get-repo must run for this manifest entry. */
export function needsFetch(
  entry: ManifestEntry | undefined,
  branch: string | undefined,
): FetchDecision {
  if (!entry) return { needed: true, reason: "not in manifest" };
  if (!entry.dir || !isDir(path.join(entry.dir, ".git"))) {
    return { needed: true, reason: "checkout missing on disk" };
  }
  if (branch && entry.branch !== branch) {
    return { needed: true, reason: `branch switch to '${branch}'` };
  }
  const fetched = new Date(entry.fetched_at ?? "");
  if (Number.isNaN(fetched.getTime())) return { needed: true, reason: "invalid fetched_at" };
  const ageMs = Date.now() - fetched.getTime();
  if (ageMs > TTL_MS) {
    return { needed: true, reason: `stale (last fetch ${Math.floor(ageMs / 86_400_000)}d ago)` };
  }
  return { needed: false, reason: "" };
}

interface GitRun {
  ok: boolean;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

type GitOptions = Omit<RunOptions, "timeoutMs"> & { timeoutMs?: number };

async function git(args: readonly string[], opts: GitOptions): Promise<GitRun> {
  const res = await run(["git", ...args], { timeoutMs: QUICK_TIMEOUT_MS, ...opts });
  if (res.kind === "nobin") {
    throw new GetRepoError("Error: `git` not found on the PATH passed to Hermes.");
  }
  if (res.kind === "timeout") return { ok: false, timedOut: true, stdout: "", stderr: res.partial };
  return { ok: res.code === 0, timedOut: false, stdout: res.stdout, stderr: res.stderr };
}

/**
 * Clone or hard-resync `repo`. Throws GetRepoError with a user-facing message
 * (git output + hints) on fatal failure — nonexistent repo, missing branch,
 * missing git binary.
 */
async function getRepo(
  repo: string,
  wantedBranch: string | undefined,
  heartbeat: Heartbeat,
  signal: AbortSignal,
): Promise<RepoCheckout> {
  const slash = repo.indexOf("/");
  const org = repo.slice(0, slash);
  const name = repo.slice(slash + 1).replace(/\.git$/, "");
  const url = `https://github.com/${org}/${name}.git`;
  const canon = `github.com/${org}/${name}`;
  const warnings: string[] = [];

  await mkdir(REPOS_DIR, { recursive: true });
  let dir = path.join(REPOS_DIR, name);

  // URL-normalized collision check (ssh == https): same name, other owner
  if (isDir(path.join(dir, ".git"))) {
    const remote = await git(["-C", dir, "remote", "get-url", "origin"], { signal });
    if (remote.ok && normGitUrl(remote.stdout) !== canon) {
      dir = path.join(REPOS_DIR, `${org}--${name}`);
    }
  }

  // Self-heal: leftover file or corrupted half-clone
  if (exists(dir)) {
    const check = await git(["-C", dir, "rev-parse", "--git-dir"], { signal });
    if (!check.ok) {
      warnings.push(`'${path.basename(dir)}' existed but was not a valid git repo — re-cloned`);
      await rm(dir, { recursive: true, force: true });
    }
  }

  let stale = false;
  if (!exists(dir)) {
    log.info(`cloning ${repo}...`);
    const clone = await git(["clone", "--quiet", "--filter=blob:none", url, dir], {
      timeoutMs: FETCH_TIMEOUT_MS,
      heartbeat,
      signal,
    });
    if (clone.timedOut) {
      await rm(dir, { recursive: true, force: true });
      throw new GetRepoError(
        `Error: clone of ${repo} timed out after ${FETCH_TIMEOUT_MS / 1000}s.`,
      );
    }
    if (!clone.ok) {
      await rm(dir, { recursive: true, force: true }); // never leave a half-clone behind
      throw new GetRepoError(
        `get-repo ERROR: clone failed for ${repo}\n${(clone.stderr || clone.stdout).slice(-600)}\n` +
          `HINT: verify the identifier and its accessibility: gh repo view ${repo}\n` +
          `HINT: if the repository is private, check credentials: gh auth status`,
      );
    }
  } else {
    log.info(`updating ${repo} from origin...`);
    const fetch = await git(["-C", dir, "fetch", "--quiet", "--prune", "origin"], {
      timeoutMs: FETCH_TIMEOUT_MS,
      heartbeat,
      signal,
    });
    if (!fetch.ok) {
      stale = true;
      warnings.push("fetch failed — using the existing local copy (it may be STALE)");
    }
  }

  await git(["-C", dir, "remote", "set-head", "origin", "--auto"], { signal });

  // Branch resolution: requested branch, else origin's default, else main
  const head = await git(
    ["-C", dir, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    { signal },
  );
  const defaultBranch = head.ok && head.stdout ? head.stdout.replace(/^origin\//, "") : "main";

  let branch = defaultBranch;
  if (wantedBranch) {
    const wanted = await git(
      ["-C", dir, "rev-parse", "--quiet", "--verify", `refs/remotes/origin/${wantedBranch}`],
      { signal },
    );
    if (wanted.ok) {
      branch = wantedBranch;
    } else {
      warnings.push(
        `branch '${wantedBranch}' not found on origin — fell back to default '${defaultBranch}'`,
      );
    }
  }

  const verified = await git(
    ["-C", dir, "rev-parse", "--quiet", "--verify", `refs/remotes/origin/${branch}`],
    { signal },
  );
  if (!verified.ok) {
    throw new GetRepoError(
      `get-repo ERROR: branch '${branch}' is unknown and could not be fetched\n` +
        `HINT: list remote branches: gh api repos/${repo}/branches --jq '.[].name'`,
    );
  }

  // Hard sync: local state == origin/<branch>, unconditionally
  const checkout = await git(
    ["-C", dir, "checkout", "--quiet", "--force", "-B", branch, `origin/${branch}`],
    { timeoutMs: 120_000, signal },
  );
  if (!checkout.ok) {
    throw new GetRepoError(
      `get-repo ERROR: checkout failed\n${(checkout.stderr || checkout.stdout).slice(-400)}`,
    );
  }
  await git(["-C", dir, "clean", "--quiet", "-fd"], { signal });

  if (stale) {
    warnings.push(`checked out '${branch}' from the last fetched state (update failed)`);
  }
  log.info(`ready: ${repo} @ ${branch}`);
  return { dir, branch, warnings };
}

/** Fetch the repo if the policy requires it; return the checkout dir + warnings. */
export function ensureRepo(
  repo: string,
  branch: string | undefined,
  heartbeat: Heartbeat,
  signal: AbortSignal,
): Promise<{ dir: string; warnings: string[] }> {
  return fetchLock.runExclusive(async () => {
    const entry = await manifestGet(repo);
    const decision = needsFetch(entry, branch);
    if (!decision.needed && entry) return { dir: entry.dir, warnings: [] };
    log.info(`fetching ${repo} (${decision.reason})`);
    const checkout = await getRepo(repo, branch, heartbeat, signal);
    await manifestPut(repo, {
      dir: checkout.dir,
      branch: checkout.branch,
      fetched_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
    return { dir: checkout.dir, warnings: checkout.warnings };
  });
}
