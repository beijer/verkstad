import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { project, type Project } from "./project.ts";

/** A worktree on a new branch off main with one commit, as an implementing agent leaves it. */
function worktree(p: Project, branch: string): string {
  const wt = join(p.dir, "..", "wt");
  p.git("worktree", "add", "--quiet", "-b", branch, wt, "main");
  writeFileSync(join(wt, "feature.txt"), "a feature\n");
  p.git("-C", wt, "add", "feature.txt");
  p.git("-C", wt, "commit", "--quiet", "-m", "Adds feature.txt");
  return wt;
}

function logDir(p: Project): string {
  return join(p.dir, ".claude", "verkstad");
}

test("review record writes the branch and the commit HEAD is on to review-<branch>.json in the log directory", (t) => {
  const p = project(t);
  const wt = worktree(p, "issue-7");
  const head = p.git("-C", wt, "rev-parse", "HEAD");
  const short = p.git("-C", wt, "rev-parse", "--short", "HEAD");
  const path = join(logDir(p), "review-issue-7.json");

  const r = p.runIn(wt, "review", "record");

  assert.equal(r.stderr, "");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, `Recorded a review of issue-7 at ${short} in ${path}.\n`);
  const recorded = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(recorded.branch, "issue-7");
  assert.equal(recorded.commit, head);
  assert.match(recorded.recordedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(Object.keys(recorded).sort(), ["branch", "commit", "recordedAt"]);
});

test("a second review record replaces the first with the commit HEAD is on now", (t) => {
  const p = project(t);
  const wt = worktree(p, "issue-7");
  p.runIn(wt, "review", "record");
  writeFileSync(join(wt, "fix.txt"), "a fix\n");
  p.git("-C", wt, "add", "fix.txt");
  p.git("-C", wt, "commit", "--quiet", "-m", "Adds fix.txt");

  const r = p.runIn(wt, "review", "record");

  assert.equal(r.code, 0, r.stderr);
  const recorded = JSON.parse(readFileSync(join(logDir(p), "review-issue-7.json"), "utf8"));
  assert.equal(recorded.commit, p.git("-C", wt, "rev-parse", "HEAD"));
});

test("review record names a branch with a slash in it by its escaped name, in the log directory itself", (t) => {
  const p = project(t);
  const wt = worktree(p, "feature/panel");

  const r = p.runIn(wt, "review", "record");

  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(readdirSync(logDir(p)), ["review-feature%2Fpanel.json"]);
  assert.equal(JSON.parse(readFileSync(join(logDir(p), "review-feature%2Fpanel.json"), "utf8")).branch, "feature/panel");
});

test("review record on a detached HEAD fails and records nothing", (t) => {
  const p = project(t);
  const wt = worktree(p, "issue-7");
  p.git("-C", wt, "switch", "--quiet", "--detach");

  const r = p.runIn(wt, "review", "record");

  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "verkstad review: HEAD is detached; a review is recorded for the branch it reviewed, so switch to it first\n");
  assert.equal(existsSync(logDir(p)), false);
});

test("review with no or an unknown verb is a usage error", (t) => {
  const p = project(t);

  for (const args of [[], ["check"], ["record", "7"]]) {
    const r = p.run("review", ...args);
    assert.equal(r.code, 2, args.join(" "));
    assert.equal(r.stderr, "verkstad review: usage: verkstad review record\n");
  }
});
