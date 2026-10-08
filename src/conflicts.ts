// `verkstad conflicts <n>`: whether Ticket #n's branch rebases cleanly onto the
// base. It reads the base branch from the Contract, fetches, and asks
// `git merge-tree` to merge issue-<n> with origin/<base> without touching a
// worktree: the files that merge would conflict in, one per line, and exit 1;
// nothing and exit 0 when it is clean. A Verdict is given for a patch, and a
// rebase that conflicts changes the patch, so a Run asks this before
// Verifying (ADR 0005). One merge stands in for the rebase: a rebase replays the
// branch commit by commit, so it can still stop where the merge is clean, as when
// one commit changes a line and a later one changes it back.
//
// `verkstad conflicts <n> --rebase <worktree>`: the same, and a branch that
// rebases cleanly is then rebased onto origin/<base> in its worktree, which must
// be clean and on issue-<n>, and the new HEAD printed. Even a clean rebase can
// change the patch, when a hunk's context moved on the base, so the Verifier
// Walks the patch Landing will push. A rebase that stops after all is aborted:
// nothing changes but on a clean rebase.

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { readBaseBranch } from "./contract.ts";
import { Failure } from "./fail.ts";
import { git, tryGit, worktreeRoot } from "./git.ts";

const USAGE = "usage: verkstad conflicts <n> [--rebase <worktree>]";

export function conflicts(args: string[]): void {
  const rest = [...args];
  let worktree: string | undefined;
  const at = rest.indexOf("--rebase");
  if (at !== -1) {
    const value = rest[at + 1];
    if (value === undefined || value.startsWith("-")) throw new Failure(`--rebase needs a worktree; ${USAGE}`, 2);
    worktree = resolve(value);
    rest.splice(at, 2);
  }
  const unknown = rest.find((a) => a.startsWith("-"));
  if (unknown !== undefined) throw new Failure(`unknown option '${unknown}'; ${USAGE}`, 2);
  if (rest.length !== 1 || !/^[1-9][0-9]*$/.test(rest[0])) throw new Failure(`needs one Ticket number; ${USAGE}`, 2);
  const branch = `issue-${rest[0]}`;
  const root = worktreeRoot(process.cwd());
  const upstream = `origin/${readBaseBranch(root)}`;
  if (tryGit(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).status !== 0) {
    throw new Failure(`${branch} does not exist`);
  }
  const rebaseRoot = worktree === undefined ? undefined : checkWorktree(worktree, branch);
  git(root, ["fetch", "--quiet", "origin"]);

  // With --name-only and --no-messages, stdout is the merged tree's id, then each conflicted file once.
  const r = tryGit(root, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", upstream, branch]);
  if (r.status === 1) {
    const files = r.stdout.split("\0").slice(1).filter(Boolean);
    process.stdout.write(files.map((f) => `${f}\n`).join(""));
    throw new Failure(`${branch} would conflict with ${upstream} in ${files.length} file${files.length === 1 ? "" : "s"}`);
  }
  if (r.status !== 0) throw new Failure(`could not merge ${branch} with ${upstream}: ${r.stderr.trim() || `exit ${r.status}`}`);
  if (rebaseRoot !== undefined) rebase(rebaseRoot, branch, upstream);
}

/** The root of `worktree`, checked to be one `--rebase` may rebase: a clean worktree on `branch`. */
function checkWorktree(worktree: string, branch: string): string {
  const refuse = (why: string) => new Failure(`${worktree} ${why}; nothing was rebased`);
  if (!existsSync(worktree) || !statSync(worktree).isDirectory()) throw refuse("is not a directory");
  const top = tryGit(worktree, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) throw refuse("is not in a git worktree");
  const root = top.stdout.trim();
  const current = git(root, ["branch", "--show-current"]).trim();
  if (current !== branch) throw refuse(`is on ${current ? `branch ${current}` : "a detached HEAD"}, not ${branch}`);
  if (git(root, ["status", "--porcelain"]).trim() !== "") throw refuse("has uncommitted changes");
  return root;
}

/** Rebases the worktree at `root` onto `upstream` unless it is already on it, printing HEAD either way. */
function rebase(root: string, branch: string, upstream: string): void {
  const head = () => git(root, ["rev-parse", "--short", "HEAD"]).trim();
  if (tryGit(root, ["merge-base", "--is-ancestor", upstream, "HEAD"]).status === 0) {
    process.stdout.write(`${branch} is already on ${upstream}: ${head()}\n`);
    return;
  }
  const r = tryGit(root, ["rebase", "--quiet", upstream]);
  if (r.status !== 0) {
    const unmerged = git(root, ["diff", "--name-only", "--diff-filter=U", "-z"]).split("\0").filter(Boolean);
    const abort = tryGit(root, ["rebase", "--abort"]);
    if (abort.status !== 0) throw new Failure(`rebasing ${branch} onto ${upstream} stopped, and aborting it failed: ${abort.stderr.trim()}`);
    process.stdout.write(unmerged.map((f) => `${f}\n`).join(""));
    const how = unmerged.length ? `conflicts in ${unmerged.join(", ")}` : `a failure: ${r.stderr.trim()}`;
    throw new Failure(`rebasing ${branch} onto ${upstream} stopped on ${how}; nothing was rebased`);
  }
  process.stdout.write(`Rebased ${branch} onto ${upstream}: ${head()}\n`);
}
