import assert from "node:assert/strict";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { project, type Project } from "./project.ts";

const BASE_FILES = {
  "a.txt": "one\ntwo\nthree\n",
  "b.txt": "alpha\nbeta\ngamma\n",
  "c.txt": "red\ngreen\nblue\n",
};

/** Commits files on branch issue-<n> in a worktree of its own, as an implementing agent does, and returns the worktree. */
function ticketBranch(p: Project, n: number, files: Record<string, string>): string {
  const wt = join(p.dir, "..", `agent-${n}`);
  p.git("worktree", "add", "--quiet", "-b", `issue-${n}`, wt, "main");
  for (const [path, content] of Object.entries(files)) writeFileSync(join(wt, path), content);
  p.git("-C", wt, "add", "-A");
  p.git("-C", wt, "commit", "--quiet", "-m", `Ticket work. Refs #${n}`);
  return realpathSync(wt);
}

/** Pushes a commit to origin's main from another clone, as a Landing would, without the main checkout fetching it. */
function landElsewhere(p: Project, files: Record<string, string>): void {
  const clone = join(p.dir, "..", "elsewhere");
  if (!existsSync(clone)) p.git("clone", "--quiet", p.origin, clone);
  p.git("-C", clone, "pull", "--quiet", "--ff-only");
  for (const [path, content] of Object.entries(files)) writeFileSync(join(clone, path), content);
  p.git("-C", clone, "add", "-A");
  p.git("-C", clone, "commit", "--quiet", "-m", "Another Ticket landed");
  p.git("-C", clone, "push", "--quiet", "origin", "main");
}

test("conflicts fetches, then prints each file a rebase of issue-<n> onto origin/<base> would conflict in and exits 1", (t) => {
  const p = project(t, { files: BASE_FILES });
  ticketBranch(p, 7, { "a.txt": "one\nTWO on the branch\nthree\n", "c.txt": "red\nGREEN on the branch\nblue\n", "b.txt": "alpha\nbeta\ngamma\ndelta\n" });
  // Landed after the branch left main, and not yet fetched: only a fetch shows the conflict.
  landElsewhere(p, { "a.txt": "one\nTwo on main\nthree\n", "c.txt": "red\nGreen on main\nblue\n", "b.txt": "ALPHA\nbeta\ngamma\n" });

  const r = p.run("conflicts", "7");

  assert.equal(r.stdout, "a.txt\nc.txt\n");
  assert.equal(r.stderr, "verkstad conflicts: issue-7 would conflict with origin/main in 2 files\n");
  assert.equal(r.code, 1);
});

test("conflicts prints nothing and exits 0 when issue-<n> rebases cleanly, run in the Ticket's worktree too", (t) => {
  const p = project(t, { files: BASE_FILES });
  const wt = ticketBranch(p, 7, { "a.txt": "one\nTWO on the branch\nthree\n" });
  landElsewhere(p, { "b.txt": "alpha\nBeta on main\ngamma\n", "a.txt": "one\ntwo\nthree\nfour on main\n" });

  for (const r of [p.run("conflicts", "7"), p.runIn(wt, "conflicts", "7")]) {
    assert.equal(r.stderr, "");
    assert.equal(r.stdout, "");
    assert.equal(r.code, 0);
  }
  // It fetched what landed meanwhile, and it only reads: the branch has not moved.
  assert.equal(p.git("rev-parse", "origin/main"), p.git("--git-dir", p.origin, "rev-parse", "main"));
  assert.equal(p.git("log", "--format=%s", "-1", "issue-7"), "Ticket work. Refs #7");
});

test("conflicts on a Ticket with no branch says so and exits 1", (t) => {
  const p = project(t, { files: BASE_FILES });

  const r = p.run("conflicts", "9");

  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "verkstad conflicts: issue-9 does not exist\n");
  assert.equal(r.code, 1);
});

test("conflicts needs one Ticket number", (t) => {
  const p = project(t);

  const r = p.run("conflicts", "seven");

  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "verkstad conflicts: needs one Ticket number; usage: verkstad conflicts <n> [--rebase <worktree>]\n");
  assert.equal(r.code, 2);
});

test("conflicts --rebase rebases a clean worktree's issue-<n>, behind origin/<base>, onto it and prints the new HEAD", (t) => {
  const p = project(t, { files: BASE_FILES });
  const wt = ticketBranch(p, 7, { "a.txt": "one\nTWO on the branch\nthree\n" });
  landElsewhere(p, { "b.txt": "alpha\nBeta on main\ngamma\n" });

  const r = p.run("conflicts", "7", "--rebase", wt);

  const head = p.git("-C", wt, "rev-parse", "--short", "HEAD");
  assert.equal(r.stderr, "");
  assert.equal(r.stdout, `Rebased issue-7 onto origin/main: ${head}\n`);
  assert.equal(r.code, 0);
  assert.equal(p.git("-C", wt, "rev-parse", "HEAD~1"), p.git("--git-dir", p.origin, "rev-parse", "main"));
  assert.equal(p.git("-C", wt, "log", "--format=%s", "-1"), "Ticket work. Refs #7");
  assert.equal(p.git("-C", wt, "show", "HEAD:b.txt"), "alpha\nBeta on main\ngamma");
  assert.equal(p.git("-C", wt, "status", "--porcelain"), "");
});

test("conflicts --rebase on an issue-<n> level with origin/<base> changes nothing and exits 0", (t) => {
  const p = project(t, { files: BASE_FILES });
  const wt = ticketBranch(p, 7, { "a.txt": "one\nTWO on the branch\nthree\n" });
  const before = p.git("-C", wt, "rev-parse", "HEAD");

  const r = p.run("conflicts", "7", "--rebase", wt);

  assert.equal(r.stderr, "");
  assert.equal(r.stdout, `issue-7 is already on origin/main: ${p.git("rev-parse", "--short", before)}\n`);
  assert.equal(r.code, 0);
  assert.equal(p.git("-C", wt, "rev-parse", "HEAD"), before);
});

test("conflicts --rebase on an issue-<n> that would conflict prints the files, changes nothing and exits 1", (t) => {
  const p = project(t, { files: BASE_FILES });
  const wt = ticketBranch(p, 7, { "a.txt": "one\nTWO on the branch\nthree\n" });
  landElsewhere(p, { "a.txt": "one\nTwo on main\nthree\n" });
  const before = p.git("-C", wt, "rev-parse", "HEAD");

  const r = p.run("conflicts", "7", "--rebase", wt);

  assert.equal(r.stdout, "a.txt\n");
  assert.equal(r.stderr, "verkstad conflicts: issue-7 would conflict with origin/main in 1 file\n");
  assert.equal(r.code, 1);
  assert.equal(p.git("-C", wt, "rev-parse", "HEAD"), before);
  assert.equal(p.git("-C", wt, "status", "--porcelain"), "");
});

test("conflicts --rebase refuses a worktree with uncommitted changes and changes nothing", (t) => {
  const p = project(t, { files: BASE_FILES });
  const wt = ticketBranch(p, 7, { "a.txt": "one\nTWO on the branch\nthree\n" });
  landElsewhere(p, { "b.txt": "alpha\nBeta on main\ngamma\n" });
  writeFileSync(join(wt, "c.txt"), "red\nnot committed\nblue\n");
  const before = p.git("-C", wt, "rev-parse", "HEAD");

  const r = p.run("conflicts", "7", "--rebase", wt);

  assert.equal(r.stdout, "");
  assert.equal(r.stderr, `verkstad conflicts: ${wt} has uncommitted changes; nothing was rebased\n`);
  assert.equal(r.code, 1);
  assert.equal(p.git("-C", wt, "rev-parse", "HEAD"), before);
  assert.equal(p.git("-C", wt, "status", "--porcelain"), "M c.txt");
});

test("conflicts --rebase refuses a worktree that is not on issue-<n>", (t) => {
  const p = project(t, { files: BASE_FILES });
  const wt = ticketBranch(p, 7, { "a.txt": "one\nTWO on the branch\nthree\n" });
  ticketBranch(p, 8, { "b.txt": "alpha\nBETA on the branch\ngamma\n" });

  const r = p.run("conflicts", "8", "--rebase", wt);

  assert.equal(r.stdout, "");
  assert.equal(r.stderr, `verkstad conflicts: ${wt} is on branch issue-7, not issue-8; nothing was rebased\n`);
  assert.equal(r.code, 1);
});

test("conflicts --rebase needs a worktree", (t) => {
  const p = project(t);

  const r = p.run("conflicts", "7", "--rebase");

  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "verkstad conflicts: --rebase needs a worktree; usage: verkstad conflicts <n> [--rebase <worktree>]\n");
  assert.equal(r.code, 2);
});
