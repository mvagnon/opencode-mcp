import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { needsFetch, normGitUrl } from "./get-repo.ts";

describe("normGitUrl", () => {
  it("normalizes ssh scp-like URLs", () => {
    assert.equal(normGitUrl("git@github.com:owner/repo.git"), "github.com/owner/repo");
  });

  it("normalizes https URLs", () => {
    assert.equal(normGitUrl("https://github.com/owner/repo.git"), "github.com/owner/repo");
  });

  it("normalizes ssh:// URLs", () => {
    assert.equal(normGitUrl("ssh://git@github.com/owner/repo"), "github.com/owner/repo");
  });

  it("strips trailing slashes and surrounding whitespace", () => {
    assert.equal(normGitUrl("  http://github.com/owner/repo//  "), "github.com/owner/repo");
  });

  it("maps equivalent ssh and https remotes to the same canonical form", () => {
    assert.equal(
      normGitUrl("git@github.com:owner/repo.git"),
      normGitUrl("https://github.com/owner/repo"),
    );
  });
});

describe("needsFetch", () => {
  let checkoutDir: string;

  before(() => {
    checkoutDir = mkdtempSync(path.join(os.tmpdir(), "opencode-mcp-test-"));
    mkdirSync(path.join(checkoutDir, ".git"));
  });

  after(() => {
    rmSync(checkoutDir, { recursive: true, force: true });
  });

  const freshEntry = () => ({
    dir: checkoutDir,
    branch: "main",
    fetched_at: new Date().toISOString(),
  });

  it("fetches when the repo is not in the manifest", () => {
    assert.equal(needsFetch(undefined, undefined).needed, true);
  });

  it("fetches when the checkout is missing on disk", () => {
    const entry = { ...freshEntry(), dir: path.join(checkoutDir, "nope") };
    assert.equal(needsFetch(entry, undefined).needed, true);
  });

  it("fetches when a different branch is requested", () => {
    assert.equal(needsFetch(freshEntry(), "canary").needed, true);
  });

  it("fetches when fetched_at is missing or invalid", () => {
    assert.equal(needsFetch({ dir: checkoutDir, branch: "main" }, undefined).needed, true);
    const invalid = { ...freshEntry(), fetched_at: "not-a-date" };
    assert.equal(needsFetch(invalid, undefined).needed, true);
  });

  it("fetches when the last fetch is older than the TTL", () => {
    const stale = {
      ...freshEntry(),
      fetched_at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
    };
    assert.equal(needsFetch(stale, undefined).needed, true);
  });

  it("reuses a fresh checkout without a branch request", () => {
    assert.equal(needsFetch(freshEntry(), undefined).needed, false);
  });

  it("reuses a fresh checkout when the requested branch matches", () => {
    assert.equal(needsFetch(freshEntry(), "main").needed, false);
  });
});
