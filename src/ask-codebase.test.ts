import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isValidBranch, isValidRepoSlug, truncate } from "./ask-codebase.ts";

describe("isValidRepoSlug", () => {
  it("accepts exact owner/repo slugs", () => {
    assert.equal(isValidRepoSlug("vercel/next.js"), true);
    assert.equal(isValidRepoSlug("a/b"), true);
    assert.equal(isValidRepoSlug("my-org/repo_name-1.0"), true);
  });

  it("rejects owners with leading or trailing hyphens", () => {
    assert.equal(isValidRepoSlug("-owner/repo"), false);
    assert.equal(isValidRepoSlug("owner-/repo"), false);
  });

  it("rejects anything that is not exactly one owner/repo pair", () => {
    assert.equal(isValidRepoSlug(""), false);
    assert.equal(isValidRepoSlug("owner"), false);
    assert.equal(isValidRepoSlug("owner/repo/extra"), false);
    assert.equal(isValidRepoSlug("owner/re po"), false);
    assert.equal(isValidRepoSlug("https://github.com/owner/repo"), false);
  });
});

describe("isValidBranch", () => {
  it("accepts common branch names", () => {
    assert.equal(isValidBranch("main"), true);
    assert.equal(isValidBranch("feature/foo-bar_1.2"), true);
    assert.equal(isValidBranch("v2"), true);
  });

  it("rejects names that do not start with an alphanumeric", () => {
    assert.equal(isValidBranch("-x"), false);
    assert.equal(isValidBranch(".hidden"), false);
  });

  it("rejects path traversal and over-long names", () => {
    assert.equal(isValidBranch("a..b"), false);
    assert.equal(isValidBranch(`a${"b".repeat(200)}`), true);
    assert.equal(isValidBranch(`a${"b".repeat(201)}`), false);
  });
});

describe("truncate", () => {
  it("returns short text unchanged", () => {
    assert.equal(truncate("hello", 10), "hello");
    assert.equal(truncate("hello", 5), "hello");
  });

  it("cuts long text at the limit and appends a marker", () => {
    const result = truncate("abcdefghij", 4);
    assert.equal(result.startsWith("abcd"), true);
    assert.equal(result.includes("efgh"), false);
    assert.equal(result.length > 4, true);
  });
});
