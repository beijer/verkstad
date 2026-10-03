import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { project, type Project } from "./project.ts";

/** A fresh agent worktree as Claude Code makes one: on a branch of its own, off the main checkout's main. */
function agentWorktree(p: Project, name = "agent-a"): string {
  const wt = join(p.dir, "..", name);
  p.git("worktree", "add", "--quiet", "-b", `worktree-${name}`, wt, "main");
  return realpathSync(wt);
}

/** Pushes a commit to origin's main from another clone, as a Landing would. */
function landElsewhere(p: Project, path: string, content: string, message: string): string {
  const clone = join(p.dir, "..", "elsewhere");
  if (!existsSync(clone)) p.git("clone", "--quiet", p.origin, clone);
  p.git("-C", clone, "pull", "--quiet", "--ff-only");
  writeFileSync(join(clone, path), content);
  p.git("-C", clone, "add", path);
  p.git("-C", clone, "commit", "--quiet", "-m", message);
  p.git("-C", clone, "push", "--quiet", "origin", "main");
  return p.git("--git-dir", p.origin, "rev-parse", "main");
}

/** Commits files on branch issue-<n> in a worktree of its own, then removes that worktree, keeping the branch. */
function earlierBranch(p: Project, n: number, files: Record<string, string>): string {
  const wt = join(p.dir, "..", `earlier-${n}`);
  p.git("worktree", "add", "--quiet", "-b", `issue-${n}`, wt, "main");
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(wt, path), content);
    p.git("-C", wt, "add", path);
  }
  p.git("-C", wt, "commit", "--quiet", "-m", `Ticket work. Refs #${n}`);
  p.git("worktree", "remove", wt);
  return p.git("rev-parse", `issue-${n}`);
}

function branches(p: Project): string[] {
  return p.git("branch", "--format=%(refname:short)").split("\n").filter(Boolean).sort();
}

function short(p: Project, sha: string): string {
  return p.git("rev-parse", "--short", sha);
}

test("in a fresh agent worktree, start puts it on issue-<n> at the latest origin/<base> and deletes the worktree's branch", (t) => {
  const p = project(t);
  const wt = agentWorktree(p);
  const latest = landElsewhere(p, "landed.txt", "landed\n", "Another Ticket landed");

  const r = p.runIn(wt, "start", "7");

  assert.equal(r.stderr, "");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, `On issue-7 at origin/main (${short(p, latest)}). Deleted branch worktree-agent-a.\n`);
  assert.equal(p.git("-C", wt, "branch", "--show-current"), "issue-7");
  assert.equal(p.git("-C", wt, "rev-parse", "HEAD"), latest);
  assert.deepEqual(branches(p), ["issue-7", "main"]);
  assert.equal(p.git("-C", wt, "status", "--porcelain"), "");
});

test("start reads the base branch from the Contract", (t) => {
  const p = project(t, { contract: { baseBranch: "trunk", surfaces: [] } });
  p.git("push", "--quiet", "origin", "main:trunk");
  const wt = agentWorktree(p);
  const clone = join(p.dir, "..", "elsewhere");
  p.git("clone", "--quiet", "--branch", "trunk", p.origin, clone);
  writeFileSync(join(clone, "on-trunk.txt"), "trunk\n");
  p.git("-C", clone, "add", "on-trunk.txt");
  p.git("-C", clone, "commit", "--quiet", "-m", "On trunk");
  p.git("-C", clone, "push", "--quiet", "origin", "trunk");
  const trunk = p.git("--git-dir", p.origin, "rev-parse", "trunk");

  const r = p.runIn(wt, "start", "7");

  assert.equal(r.stderr, "");
  assert.equal(r.stdout, `On issue-7 at origin/trunk (${short(p, trunk)}). Deleted branch worktree-agent-a.\n`);
  assert.equal(p.git("-C", wt, "rev-parse", "HEAD"), trunk);
});

test("start --resume switches to the existing issue-<n>, rebases it onto the latest origin/<base> and deletes the worktree's branch", (t) => {
  const p = project(t, { files: { "a.txt": "a\n" } });
  earlierBranch(p, 7, { "ticket.txt": "from the Ticket\n" });
  const latest = landElsewhere(p, "landed.txt", "landed\n", "Another Ticket landed");
  const wt = agentWorktree(p);

  const r = p.runIn(wt, "start", "7", "--resume");

  assert.equal(r.stderr, "");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, `On issue-7, rebased onto origin/main (${short(p, latest)}). Deleted branch worktree-agent-a.\n`);
  assert.equal(p.git("-C", wt, "branch", "--show-current"), "issue-7");
  assert.equal(p.git("-C", wt, "rev-parse", "HEAD~1"), latest, "the Ticket's commit sits on the latest base");
  assert.equal(p.git("-C", wt, "log", "-1", "--format=%s"), "Ticket work. Refs #7");
  assert.deepEqual(branches(p), ["issue-7", "main"]);
  assert.equal(p.git("-C", wt, "status", "--porcelain"), "");
});

test("start --resume takes issue-<n> from origin when only a Park left it there", (t) => {
  const p = project(t);
  const head = earlierBranch(p, 7, { "ticket.txt": "from the Ticket\n" });
  p.git("push", "--quiet", "origin", "issue-7");
  p.git("branch", "--quiet", "-D", "issue-7");
  const latest = landElsewhere(p, "landed.txt", "landed\n", "Another Ticket landed");
  const wt = agentWorktree(p);

  const r = p.runIn(wt, "start", "7", "--resume");

  assert.equal(r.stderr, "");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, `On issue-7, rebased onto origin/main (${short(p, latest)}). Deleted branch worktree-agent-a.\n`);
  assert.equal(p.git("-C", wt, "branch", "--show-current"), "issue-7");
  assert.equal(p.git("-C", wt, "rev-parse", "HEAD~1"), latest);
  assert.notEqual(p.git("-C", wt, "rev-parse", "HEAD"), head, "the Ticket's commit is rebased");
  assert.equal(p.git("-C", wt, "log", "-1", "--format=%s"), "Ticket work. Refs #7");
});

test("start --resume stops on a rebase conflict naming the conflicting files, the rebase left for the agent to resolve", (t) => {
  const p = project(t, { files: { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" } });
  earlierBranch(p, 7, { "a.txt": "a from the Ticket\n", "b.txt": "b from the Ticket\n", "c.txt": "c from the Ticket\n" });
  landElsewhere(p, "a.txt", "a from main\n", "Changes a");
  landElsewhere(p, "b.txt", "b from main\n", "Changes b");
  const wt = agentWorktree(p);

  const r = p.runIn(wt, "start", "7", "--resume");

  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.equal(
    r.stderr,
    "verkstad start: rebasing issue-7 onto origin/main stopped on conflicts in a.txt, b.txt; " +
      "resolve them (Skill verkstad:merge-conflicts) and run `git rebase --continue`\n",
  );
  assert.equal(p.git("-C", wt, "diff", "--name-only", "--diff-filter=U"), "a.txt\nb.txt");
  assert.deepEqual(branches(p).filter((b) => !b.startsWith("(")), ["issue-7", "main"], "the worktree's branch is deleted");
});

test("start refuses the main checkout and a directory outside git, changing nothing", (t) => {
  const p = project(t);
  const before = branches(p);

  const main = p.run("start", "7");
  assert.equal(main.code, 1);
  assert.equal(main.stdout, "");
  assert.equal(main.stderr, `verkstad start: ${realpathSync(p.dir)} is the main checkout, not a worktree\n`);

  const outside = join(p.dir, "..", "outside");
  mkdirSync(outside);
  const notGit = p.runIn(outside, "start", "7");
  assert.equal(notGit.code, 1);
  assert.equal(notGit.stderr, `verkstad start: not in a git checkout: ${realpathSync(outside)}\n`);

  assert.deepEqual(branches(p), before);
  assert.equal(p.git("branch", "--show-current"), "main");
});

test("start refuses a dirty worktree, changing nothing, not even fetching", (t) => {
  const p = project(t);
  const wt = agentWorktree(p);
  writeFileSync(join(wt, "scratch.txt"), "uncommitted\n");
  const fetched = p.git("rev-parse", "refs/remotes/origin/main");
  landElsewhere(p, "landed.txt", "landed\n", "Another Ticket landed");

  const r = p.runIn(wt, "start", "7");

  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, `verkstad start: ${wt} has uncommitted changes\n`);
  assert.equal(p.git("-C", wt, "branch", "--show-current"), "worktree-agent-a");
  assert.deepEqual(branches(p), ["main", "worktree-agent-a"]);
  assert.equal(p.git("rev-parse", "refs/remotes/origin/main"), fetched, "nothing was fetched");
});

test("start refuses an existing issue-<n> without --resume, and a missing one with it, changing nothing", (t) => {
  const p = project(t);
  const head = earlierBranch(p, 7, { "ticket.txt": "from the Ticket\n" });
  const wt = agentWorktree(p);

  const exists = p.runIn(wt, "start", "7");
  assert.equal(exists.code, 1);
  assert.equal(exists.stdout, "");
  assert.equal(exists.stderr, "verkstad start: issue-7 already exists; run `verkstad start 7 --resume` to continue it\n");

  const missing = p.runIn(wt, "start", "8", "--resume");
  assert.equal(missing.code, 1);
  assert.equal(missing.stdout, "");
  assert.equal(missing.stderr, "verkstad start: issue-8 does not exist; run `verkstad start 8` to create it\n");

  assert.equal(p.git("-C", wt, "branch", "--show-current"), "worktree-agent-a");
  assert.deepEqual(branches(p), ["issue-7", "main", "worktree-agent-a"]);
  assert.equal(p.git("rev-parse", "issue-7"), head);
});

test("start without a Ticket number, or with an unknown option, prints its usage and exits 2", (t) => {
  const p = project(t);
  const wt = agentWorktree(p);
  const usage = "usage: verkstad start <n> [--resume]\n";
  const cases: Array<[string[], string]> = [
    [[], `verkstad start: needs one Ticket number; ${usage}`],
    [["seven"], `verkstad start: needs one Ticket number; ${usage}`],
    [["7", "8"], `verkstad start: needs one Ticket number; ${usage}`],
    [["7", "--force"], `verkstad start: unknown option '--force'; ${usage}`],
  ];
  for (const [args, stderr] of cases) {
    const r = p.runIn(wt, "start", ...args);
    assert.equal(r.code, 2, `start ${args.join(" ")}`);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, stderr);
  }
  assert.equal(p.git("-C", wt, "branch", "--show-current"), "worktree-agent-a");
});
