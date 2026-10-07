// `verkstad conflicts <n>`: whether Ticket #n's branch rebases cleanly onto the
// base. It reads the base branch from the Contract, fetches, and asks
// `git merge-tree` to merge issue-<n> with origin/<base> without touching a
// worktree: the files that merge would conflict in, one per line, and exit 1;
// nothing and exit 0 when it is clean. A Verdict is given for a patch, and a
// rebase that conflicts changes the patch, so the orchestrator asks this before
// Verifying (ADR 0005). One merge stands in for the rebase: a rebase replays the
// branch commit by commit, so it can still stop where the merge is clean, as when
// one commit changes a line and a later one changes it back.

import { readBaseBranch } from "./contract.ts";
import { Failure } from "./fail.ts";
import { git, tryGit, worktreeRoot } from "./git.ts";

const USAGE = "usage: verkstad conflicts <n>";

export function conflicts(args: string[]): void {
  const unknown = args.find((a) => a.startsWith("-"));
  if (unknown !== undefined) throw new Failure(`unknown option '${unknown}'; ${USAGE}`, 2);
  if (args.length !== 1 || !/^[1-9][0-9]*$/.test(args[0])) throw new Failure(`needs one Ticket number; ${USAGE}`, 2);
  const branch = `issue-${args[0]}`;
  const root = worktreeRoot(process.cwd());
  const upstream = `origin/${readBaseBranch(root)}`;
  if (tryGit(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).status !== 0) {
    throw new Failure(`${branch} does not exist`);
  }
  git(root, ["fetch", "--quiet", "origin"]);

  // With --name-only and --no-messages, stdout is the merged tree's id, then each conflicted file once.
  const r = tryGit(root, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", upstream, branch]);
  if (r.status === 0) return;
  if (r.status !== 1) throw new Failure(`could not merge ${branch} with ${upstream}: ${r.stderr.trim() || `exit ${r.status}`}`);
  const files = r.stdout.split("\0").slice(1).filter(Boolean);
  process.stdout.write(files.map((f) => `${f}\n`).join(""));
  throw new Failure(`${branch} would conflict with ${upstream} in ${files.length} file${files.length === 1 ? "" : "s"}`);
}
