// `verkstad start <n>`: puts a fresh agent worktree on Ticket #n's branch. It reads
// the base branch from the Contract, fetches, creates issue-<n> from origin/<base>
// and deletes the branch the worktree came on.
//
// `verkstad start <n> --resume`: switches the worktree to the existing issue-<n>,
// deletes the branch it came on and rebases issue-<n> onto origin/<base>. A conflict
// stops the rebase where it is, for the agent to resolve.
//
// It refuses, changing nothing, outside a worktree, on a dirty worktree, and when
// issue-<n> exists without --resume or is missing with it.

import { realpathSync } from "node:fs";
import { readBaseBranch } from "./contract.ts";
import { Failure } from "./fail.ts";
import { git, mainCheckout, tryGit, worktreeRoot } from "./git.ts";

const USAGE = "usage: verkstad start <n> [--resume]";

function parseArgs(args: string[]): { n: number; resume: boolean } {
  const resume = args.includes("--resume");
  const rest = args.filter((a) => a !== "--resume");
  const unknown = rest.find((a) => a.startsWith("-"));
  if (unknown !== undefined) throw new Failure(`unknown option '${unknown}'; ${USAGE}`, 2);
  if (rest.length !== 1 || !/^[1-9][0-9]*$/.test(rest[0])) throw new Failure(`needs one Ticket number; ${USAGE}`, 2);
  return { n: Number(rest[0]), resume };
}

export function start(args: string[]): void {
  const { n, resume } = parseArgs(args);
  const root = worktreeRoot(process.cwd());
  if (realpathSync(root) === realpathSync(mainCheckout(root))) throw new Failure(`${root} is the main checkout, not a worktree`);
  if (git(root, ["status", "--porcelain"]).trim() !== "") throw new Failure(`${root} has uncommitted changes`);
  const branch = `issue-${n}`;
  const exists = tryGit(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0;
  if (exists && !resume) throw new Failure(`${branch} already exists; run \`verkstad start ${n} --resume\` to continue it`);
  if (!exists && resume) throw new Failure(`${branch} does not exist; run \`verkstad start ${n}\` to create it`);
  const base = readBaseBranch(root);
  const upstream = `origin/${base}`;
  const old = git(root, ["branch", "--show-current"]).trim();

  git(root, ["fetch", "--quiet", "origin"]);
  git(root, resume ? ["switch", "--quiet", branch] : ["switch", "--quiet", "-c", branch, upstream]);
  // The worktree's own branch goes, unless it is the Ticket's or the base: a detached HEAD has none.
  const deleted = old !== "" && old !== branch && old !== base ? old : "";
  if (deleted) git(root, ["branch", "--quiet", "-D", deleted]);
  const done = deleted ? ` Deleted branch ${deleted}.` : "";

  if (resume) {
    const rebase = tryGit(root, ["rebase", "--quiet", upstream]);
    if (rebase.status !== 0) {
      const unmerged = tryGit(root, ["diff", "-z", "--name-only", "--diff-filter=U"]).stdout.split("\0").filter(Boolean);
      if (!unmerged.length) {
        tryGit(root, ["rebase", "--abort"]);
        throw new Failure(`rebasing ${branch} onto ${upstream} failed: ${rebase.stderr.trim()}`);
      }
      throw new Failure(
        `rebasing ${branch} onto ${upstream} stopped on conflicts in ${unmerged.join(", ")}; ` +
          "resolve them (Skill verkstad:merge-conflicts) and run `git rebase --continue`",
      );
    }
  }
  const at = git(root, ["rev-parse", "--short", upstream]).trim();
  const where = resume ? `On ${branch}, rebased onto ${upstream} (${at}).` : `On ${branch} at ${upstream} (${at}).`;
  process.stdout.write(`${where}${done}\n`);
}
