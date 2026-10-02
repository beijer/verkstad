// `verkstad land <n> <worktree> <report-file>`: lands a finished Ticket's
// branch, issue-<n>, on the base branch. Under a lock, so that one Landing runs
// at a time per main checkout, it rebases the branch onto origin's base branch,
// runs the full Gate in the worktree and pushes, rebasing again when the base
// moved meanwhile. Then it closes the Ticket with the report, removes the
// worktree and the branch, fast-forwards the main checkout and prunes the log
// directory.
//
// `verkstad land --park <n> <worktree> <reason-file>`: Parks the Ticket. Its
// branch goes to origin, its worktree is removed, it is labelled needs-info,
// unassigned and told why.
//
// Every failure ends in a line `reason: <code>` the orchestrator routes on
// (REASONS below). A failed Landing keeps the branch, removes the worktree so a
// Resume can switch to the branch, and touches no issue.

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { readContract, readLandingMode } from "./contract.ts";
import { Failure } from "./fail.ts";
import { runGate } from "./gate.ts";
import { gh } from "./gh.ts";
import { commonDir, git, logDirectory, mainCheckout, tryGit } from "./git.ts";
import { describePruned, pruneLogDirectory } from "./prune.ts";

const USAGE = "usage: verkstad land <n> <worktree> <report-file> | verkstad land --park <n> <worktree> <reason-file>";
/** How many times a Landing rebases, gates and pushes before giving up on a base that keeps moving. */
const ATTEMPTS = 3;

/** Why a Landing failed, as its last line says, and what that leaves behind. */
export const REASONS = {
  refused: "the call was wrong (not a worktree, wrong branch, uncommitted changes, bad Contract); nothing was touched",
  "no-commits": "the branch has nothing that is not on the base branch; branch kept, worktree removed",
  conflict: "the rebase conflicted in the files named; branch kept as it was, worktree removed",
  "gate-failed": "the full Gate failed, its log is named; branch kept, worktree removed",
  "push-failed": "origin refused the push, or the base moved on every attempt; branch kept, worktree removed",
  "github-failed": "the branch is where it belongs, but updating the Ticket on GitHub failed; finish that by hand",
  error: "something else failed (git, gh or flock could not run, the fetch failed); the worktree is not removed",
} as const;

export type Reason = keyof typeof REASONS;

/** A failure the orchestrator routes on: the message, then `reason: <code>`. Refusals exit 2. */
class LandingFailure extends Failure {
  constructor(reason: Reason, message: string) {
    super(`${message}\nreason: ${reason}`, reason === "refused" ? 2 : 1);
  }
}

function refused(why: string): LandingFailure {
  return new LandingFailure("refused", `refused: ${why}`);
}

interface Args {
  park: boolean;
  n: number;
  /** The worktree as given, made absolute. */
  worktree: string;
  /** The report (or, with --park, the reason) file, made absolute. */
  file: string;
}

function parseArgs(args: string[]): Args {
  const park = args[0] === "--park";
  const rest = park ? args.slice(1) : args;
  if (rest.length !== 3 || !/^[1-9]\d*$/.test(rest[0])) throw refused(USAGE);
  return { park, n: Number(rest[0]), worktree: resolve(rest[1]), file: resolve(rest[2]) };
}

/** A Ticket's worktree, checked to be one Landing may take: a clean worktree on the Ticket's branch. */
interface Ticket {
  n: number;
  branch: string;
  /** The worktree's root. */
  root: string;
  main: string;
}

function checkTicket({ n, worktree }: Args): Ticket {
  if (!existsSync(worktree) || !statSync(worktree).isDirectory()) throw refused(`no worktree at ${worktree}`);
  const top = tryGit(worktree, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) throw refused(`${worktree} is not in a git worktree`);
  const root = top.stdout.trim();
  const main = mainCheckout(root);
  if (realpathSync(root) === realpathSync(main)) throw refused(`${worktree} is the main checkout, not a worktree`);
  const branch = `issue-${n}`;
  const current = git(root, ["branch", "--show-current"]).trim();
  if (current !== branch) throw refused(`${worktree} is on ${current ? `branch ${current}` : "a detached HEAD"}, not ${branch}`);
  if (git(root, ["status", "--porcelain"]).trim() !== "") throw refused(`${worktree} has uncommitted changes`);
  return { n, branch, root, main };
}

function readFile(path: string, what: string): string {
  if (!existsSync(path) || !statSync(path).isFile()) throw refused(`no ${what} at ${path}`);
  const text = readFileSync(path, "utf8").trim();
  if (!text) throw refused(`the ${what} ${path} is empty`);
  return text;
}

/** Removes the worktree, even one Claude Code locked, keeping its branch. */
function removeWorktree(ticket: Ticket): void {
  git(ticket.main, ["worktree", "remove", "--force", "--force", ticket.root]);
}

/** Fails the Landing after removing the worktree; the branch stays for a Resume. */
function didNotLand(ticket: Ticket, reason: Reason, detail: string, asItWas = false): LandingFailure {
  removeWorktree(ticket);
  const kept = `Branch ${ticket.branch} is kept${asItWas ? " as it was" : ""}; its worktree is removed.`;
  return new LandingFailure(reason, `#${ticket.n} did not land: ${detail}\n${kept}`);
}

/**
 * Takes the main checkout's Landing lock, waiting while another Landing holds it, and returns the open
 * descriptor that holds it. flock(1) locks the descriptor it is handed, which this process shares, so the
 * lock lasts until the descriptor is closed or this process exits, however it exits: no lock is ever stale.
 */
function takeLock(ticket: Ticket): number {
  const path = join(commonDir(ticket.root), "verkstad-land.lock");
  const fd = openSync(path, "a");
  const flock = (wait: boolean) =>
    spawnSync("flock", [...(wait ? [] : ["--nonblock"]), "--exclusive", "3"], {
      stdio: ["ignore", "ignore", "pipe", fd],
      encoding: "utf8",
    });
  let r = flock(false);
  if (r.error) throw new Failure(`could not run flock(1) to take the Landing lock: ${r.error.message}`);
  if (r.status === 1 && !r.stderr) {
    process.stdout.write(`Waiting for another Landing in ${ticket.main} to finish.\n`);
    r = flock(true);
  }
  if (r.status !== 0) throw new Failure(`could not take the Landing lock ${path}: ${r.stderr.trim() || `exit ${r.status}`}`);
  return fd;
}

function fetch(ticket: Ticket, base: string): void {
  const r = tryGit(ticket.root, ["fetch", "--quiet", "origin", base]);
  if (r.status !== 0) throw new Failure(`could not fetch origin/${base}: ${r.stderr.trim()}`);
}

/** Rebases, gates and pushes until the push lands or fails; returns the landed commit, abbreviated. */
function rebaseGatePush(ticket: Ticket, base: string): string {
  const upstream = `origin/${base}`;
  for (let attempt = 1; ; attempt++) {
    fetch(ticket, base);
    const rebase = tryGit(ticket.root, ["rebase", "--quiet", upstream]);
    if (rebase.status !== 0) {
      const unmerged = tryGit(ticket.root, ["diff", "-z", "--name-only", "--diff-filter=U"]).stdout.split("\0").filter(Boolean);
      tryGit(ticket.root, ["rebase", "--abort"]);
      const how = unmerged.length ? `conflicts in ${unmerged.join(", ")}.` : `failed: ${rebase.stderr.trim()}`;
      throw didNotLand(ticket, "conflict", `rebasing ${ticket.branch} onto ${upstream} ${how}`, true);
    }
    if (git(ticket.root, ["rev-list", "--count", `${upstream}..HEAD`]).trim() === "0") {
      throw didNotLand(ticket, "no-commits", `${ticket.branch} has no commits that are not on ${upstream}.`);
    }
    try {
      runGate(ticket.root, false);
    } catch (error) {
      if (!(error instanceof Failure)) throw error;
      throw didNotLand(ticket, "gate-failed", `the Gate failed: ${error.message}`);
    }
    const push = tryGit(ticket.root, ["push", "--quiet", "origin", `HEAD:refs/heads/${base}`]);
    if (push.status === 0) return git(ticket.root, ["rev-parse", "--short", "HEAD"]).trim();
    fetch(ticket, base);
    const moved = tryGit(ticket.root, ["merge-base", "--is-ancestor", upstream, "HEAD"]).status !== 0;
    if (!moved) throw didNotLand(ticket, "push-failed", `pushing to ${upstream} failed: ${push.stderr.trim()}`);
    if (attempt === ATTEMPTS) {
      throw didNotLand(ticket, "push-failed", `${upstream} moved during each of ${ATTEMPTS} Gate runs.`);
    }
    process.stdout.write(`${upstream} moved during the Gate; rebasing again (attempt ${attempt + 1} of ${ATTEMPTS}).\n`);
  }
}

/** Fast-forwards the main checkout to what landed, when it is on a clean base branch; says so when not. */
function fastForwardMain(main: string, base: string): string {
  const current = tryGit(main, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim();
  const clean = git(main, ["status", "--porcelain", "--untracked-files=no"]).trim() === "";
  if (current !== base || !clean) return `The main checkout is not on a clean ${base}, so it was not fast-forwarded.\n`;
  const r = tryGit(main, ["merge", "--quiet", "--ff-only", `origin/${base}`]);
  if (r.status !== 0) return `The main checkout's ${base} could not be fast-forwarded to origin/${base}: ${r.stderr.trim()}\n`;
  return "";
}

/** Deletes the branch from origin, where an earlier Park put it; says so when it cannot. */
function deleteParkedBranch(ticket: Ticket): string {
  const listed = tryGit(ticket.main, ["ls-remote", "--heads", "origin", `refs/heads/${ticket.branch}`]);
  if (listed.status !== 0 || listed.stdout.trim() === "") return "";
  const r = tryGit(ticket.main, ["push", "--quiet", "origin", "--delete", ticket.branch]);
  return r.status === 0 ? "" : `Could not delete ${ticket.branch} from origin: ${r.stderr.trim()}\n`;
}

function landTicket(args: Args): void {
  const ticket = checkTicket(args);
  const report = readFile(args.file, "report");
  let base: string;
  try {
    base = readContract(ticket.root).baseBranch;
    const mode = readLandingMode(ticket.root);
    if (mode !== "push") throw new Failure(`the Landing mode ${mode} is not supported yet; set landing to "push"`);
  } catch (error) {
    if (error instanceof Failure) throw refused(error.message);
    throw error;
  }
  // gh finds the Project's repo from the directory it runs in, and the worktree is about to go.
  process.chdir(ticket.main);

  const lock = takeLock(ticket);
  try {
    const sha = rebaseGatePush(ticket, base);
    let closing: Failure | null = null;
    try {
      gh(["issue", "close", String(ticket.n), "--comment", `Landed on ${base} in ${sha}.\n\n${report}\n`]);
    } catch (error) {
      if (!(error instanceof Failure)) throw error;
      closing = error;
    }
    removeWorktree(ticket);
    git(ticket.main, ["branch", "--delete", "--force", ticket.branch]);
    const notes = deleteParkedBranch(ticket) + fastForwardMain(ticket.main, base);
    if (closing) {
      process.stdout.write(notes);
      throw new LandingFailure(
        "github-failed",
        `#${ticket.n} landed on ${base} in ${sha}, but closing it failed: ${closing.message}\n` +
          "Close it by hand, with the report as the comment.",
      );
    }
    process.stdout.write(`Landed #${ticket.n} on ${base} in ${sha} and closed it.\n${notes}`);
  } finally {
    closeSync(lock);
  }
  const dir = logDirectory(ticket.main);
  process.stdout.write(describePruned(dir, pruneLogDirectory(dir)));
}

function parkTicket(args: Args): void {
  const ticket = checkTicket(args);
  const why = readFile(args.file, "reason");
  process.chdir(ticket.main);
  const sha = git(ticket.root, ["rev-parse", "--short", "HEAD"]).trim();
  const push = tryGit(ticket.root, ["push", "--quiet", "--force", "origin", `HEAD:refs/heads/${ticket.branch}`]);
  if (push.status !== 0) {
    removeWorktree(ticket);
    throw new LandingFailure(
      "push-failed",
      `#${ticket.n} was not parked: pushing ${ticket.branch} to origin failed: ${push.stderr.trim()}\n` +
        `Branch ${ticket.branch} is kept; its worktree is removed.`,
    );
  }
  removeWorktree(ticket);
  const n = String(ticket.n);
  try {
    gh(["issue", "edit", n, "--remove-label", "ready-for-agent", "--add-label", "needs-info", "--remove-assignee", "@me"]);
    gh(["issue", "comment", n, "--body", `${why}\n\nParked: branch \`${ticket.branch}\` is on origin at ${sha}; a Resume continues from it.`]);
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    throw new LandingFailure(
      "github-failed",
      `${ticket.branch} is on origin and its worktree removed, but updating #${ticket.n} failed: ${error.message}\n` +
        "Label it needs-info, unassign it and comment why by hand.",
    );
  }
  process.stdout.write(`Parked #${ticket.n}: branch ${ticket.branch} pushed to origin, worktree removed, labelled needs-info.\n`);
}

export function land(args: string[]): void {
  try {
    const parsed = parseArgs(args);
    if (parsed.park) parkTicket(parsed);
    else landTicket(parsed);
  } catch (error) {
    if (error instanceof Failure && !(error instanceof LandingFailure)) throw new LandingFailure("error", error.message);
    throw error;
  }
}
