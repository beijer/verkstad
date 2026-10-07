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
  // It only reads: the branch has not moved.
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
  assert.equal(r.stderr, "verkstad conflicts: needs one Ticket number; usage: verkstad conflicts <n>\n");
  assert.equal(r.code, 2);
});
