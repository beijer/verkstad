// `verkstad land <n> <worktree> <report-file>`: lands a finished Ticket's
// branch, issue-<n>, on the base branch. Under a lock, so that one Landing runs
// at a time per main checkout, it rebases the branch onto origin's base branch,
// checks the Ticket's Verdict, and runs the full Gate in the worktree, unless a
// full pass on the rebased tree is recorded (src/gate.ts). Then, by
// the Contract's Landing mode:
//   - push (the default): it pushes to the base branch, rebasing again when the
//     base moved meanwhile, closes the Ticket with the report and the Verdict,
//     and fast-forwards the main checkout;
//   - pull-request: it force-pushes issue-<n> to origin and opens a pull request
//     onto the base branch (or updates the open one) whose body closes the
//     Ticket on merge and carries the report and the Verdict. The Ticket stays
//     open, and assigned, until the owner merges it.
// Either way it removes the worktree and the local branch and prunes the log
// directory.
//
// `verkstad land --park <n> <worktree> <reason-file>`: Parks the Ticket. Its
// branch goes to origin, its worktree (if a failed Landing left one) is
// removed, it is labelled needs-info, unassigned and told why.
//
// Every failure ends in a line `reason: <code>` a Run routes on
// (docs/contract.md says what each leaves behind). A Landing that failed before
// its push touches no issue and keeps the branch. After a refusal or an error
// the worktree stays, and after a Verdict check fails too, since the Verifier
// Walks it next, and after push-failed in push mode, since the next Landing
// runs from it; after any other failure it is removed, so that a Resume can
// switch to the branch. A branch whose Contract narrows its base's Surfaces or
// verify fails first, with contract-narrowed, and then a branch with no
// recorded review (src/review.ts), with review-missing, both before the lock
// and the rebase: nothing changes, the worktree included.

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Checking, committedChecking, type LandingMode, narrowings, readChecking, readContract, readLandingMode } from "./contract.ts";
import { Failure } from "./fail.ts";
import { recordedPass, recordedPassLog, runGate, StepFailure } from "./gate.ts";
import { gh, ghJson } from "./gh.ts";
import { commonDir, git, logDirectory, mainCheckout, tryFetch, tryGit } from "./git.ts";
import { describePruned, pruneLogDirectory } from "./prune.ts";
import { deleteReview, missingReview } from "./review.ts";
import { checkVerdict, describeVerification, type VerdictCheck, type VerdictReason } from "./verdict.ts";

const USAGE = "usage: verkstad land <n> <worktree> <report-file> | verkstad land --park <n> <worktree> <reason-file>";
/** How many times a Landing rebases, gates and pushes before giving up on a base that keeps moving. */
const ATTEMPTS = 3;

/** Why a Landing failed, as its last line says; docs/contract.md describes each. */
type Reason =
  | "refused"
  | "review-missing"
  | "contract-narrowed"
  | "no-commits"
  | "conflict"
  | "gate-failed"
  | VerdictReason
  | "push-failed"
  | "github-failed"
  | "error";

/** A failure a Run routes on: the message, then `reason: <code>`. Refusals exit 2. */
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

/** A Ticket's branch, and its worktree unless a failed Landing already removed it. */
interface TicketBranch {
  n: number;
  branch: string;
  root: string | null;
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

/** What removing a worktree did: a line saying what it could not do, and whether it is gone. */
interface Removal {
  notes: string;
  removed: boolean;
}

/**
 * Removes the worktree, even one Claude Code locked, keeping its branch. What an agent left in it, its scratch
 * notes under .claude/verkstad/ included, goes with it: what matters is in the report, on the Ticket, or in
 * the Project's docs on the branch.
 */
function removeWorktree(main: string, root: string): Removal {
  const r = tryGit(main, ["worktree", "remove", "--force", "--force", root]);
  if (r.status === 0) return { notes: "", removed: true };
  return { notes: `Could not remove the worktree ${root}: ${r.stderr.trim()}\n`, removed: false };
}

/**
 * Fails after removing the worktree, keeping the branch for a Resume. `what` says what failed, e.g.
 * `#7 did not land: …`; a worktree that cannot be removed is mentioned, never hides the reason.
 */
function keepBranch(ticket: TicketBranch, reason: Reason, what: string, asItWas = false): LandingFailure {
  const kept = `Branch ${ticket.branch} is kept${asItWas ? " as it was" : ""}`;
  if (ticket.root === null) return new LandingFailure(reason, `${what}\n${kept}.`);
  const { notes, removed } = removeWorktree(ticket.main, ticket.root);
  return new LandingFailure(reason, `${what}\n${notes}${removed ? `${kept}; its worktree is removed.` : ""}`);
}

/** Fails with the worktree kept, clean and rebased, for a Landing that is about to be run again from it. */
function keptInWorktree(ticket: Ticket, reason: Reason, detail: string): LandingFailure {
  return new LandingFailure(reason, `#${ticket.n} did not land: ${detail}\nBranch ${ticket.branch} is kept, rebased, in its worktree.`);
}

function didNotLand(ticket: Ticket, reason: Reason, detail: string, asItWas = false): LandingFailure {
  return keepBranch(ticket, reason, `#${ticket.n} did not land: ${detail}`, asItWas);
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

function fetchBase(ticket: Ticket, base: string): void {
  const r = tryFetch(ticket.root, [base]);
  if (r.status !== 0) throw new Failure(`could not fetch origin/${base}: ${r.stderr.trim()}`);
}

/** What a Landing pushed: the landed commit, abbreviated, and what the rebased branch passed. */
interface Landed {
  sha: string;
  checked: Checked;
}

/**
 * What a rebased branch passed: the Verdict check, the tree whose recorded Gate pass stood in for the Gate,
 * and the failed first run when the Gate passed only when run once more.
 */
interface Checked {
  check: VerdictCheck;
  reused: string | null;
  firstFailure: StepFailure | null;
}

/**
 * The line a Landing's comment carries when it reused a recorded Gate pass, or when the Gate passed only
 * on its second run; none when the Gate passed at once.
 */
function describeGate({ reused, firstFailure }: Checked): string {
  if (reused !== null) return `The Gate was not run again: a full pass on this tree (${reused}) was recorded before.\n`;
  if (firstFailure !== null) return `The first Gate run failed at ${firstFailure.step} (log: ${firstFailure.log}); the second passed.\n`;
  return "";
}

/**
 * Fetches the base, rebases the branch onto it, checks the Verdict, and runs the full Gate, unless a full
 * pass on the rebased tree is recorded; a failure throws.
 */
function rebaseCheckGate(ticket: Ticket, base: string): Checked {
  const upstream = `origin/${base}`;
  fetchBase(ticket, base);
  // A full pass on the branch as it stands, before the rebase: when the Gate fails below, the Ticket's own
  // tree passed, so the failure may be a flaky test, and the Gate runs once more before it ends gate-failed.
  const passedBefore = recordedPass(ticket.root) === null ? null : (recordedPassLog(ticket.root) ?? "its log is unknown");
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
  // The Verdict is checked first, for the rebased patch, so that a branch it refuses costs no Gate run.
  const check = checkVerdict(ticket.root, ticket.n, upstream);
  if (check.failure) {
    // The worktree stays: it is clean and rebased, and the Verifier Walks it next.
    const { reason, message } = check.failure;
    throw keptInWorktree(ticket, reason, message);
  }
  const reused = recordedPass(ticket.root);
  if (reused !== null) {
    process.stdout.write(`Reused the full Gate pass recorded for tree ${reused}; no step ran.\n`);
    return { check, reused, firstFailure: null };
  }
  let firstFailure: StepFailure | null = null;
  // At most two runs: only a failing step on a tree that passed before the rebase runs once more, since it
  // may be a flaky test.
  for (;;) {
    try {
      runGate(ticket.root, false);
      return { check, reused: null, firstFailure };
    } catch (error) {
      if (!(error instanceof Failure)) throw error;
      if (firstFailure !== null) {
        const first = `the first run failed at ${firstFailure.step}, log: ${firstFailure.log}`;
        throw didNotLand(ticket, "gate-failed", `the Gate failed again when run once more (${first}): ${error.message}`);
      }
      if (passedBefore === null || !(error instanceof StepFailure)) {
        throw didNotLand(ticket, "gate-failed", `the Gate failed: ${error.message}`);
      }
      firstFailure = error;
      process.stdout.write(
        `The Gate failed at ${error.step} (log: ${error.log}) on a branch whose tree passed the full Gate before the rebase ` +
          `(log of that pass: ${passedBefore}); running it once more.\n`,
      );
    }
  }
}

/** Rebases, checks the Verdict, gates and pushes to the base branch until the push lands or fails. */
function rebaseCheckGatePush(ticket: Ticket, base: string): Landed {
  const upstream = `origin/${base}`;
  for (let attempt = 1; ; attempt++) {
    const checked = rebaseCheckGate(ticket, base);
    const push = tryGit(ticket.root, ["push", "--quiet", "origin", `HEAD:refs/heads/${base}`]);
    if (push.status === 0) return { sha: git(ticket.root, ["rev-parse", "--short", "HEAD"]).trim(), checked };
    fetchBase(ticket, base);
    const moved = tryGit(ticket.root, ["merge-base", "--is-ancestor", upstream, "HEAD"]).status !== 0;
    if (!moved) throw keptInWorktree(ticket, "push-failed", `pushing to ${upstream} failed: ${push.stderr.trim()}`);
    if (attempt === ATTEMPTS) {
      throw keptInWorktree(ticket, "push-failed", `${upstream} moved during each of ${ATTEMPTS} Gate runs.`);
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
  let mode: LandingMode;
  let checking: Checking;
  try {
    base = readContract(ticket.root).baseBranch;
    checking = readChecking(ticket.root);
    mode = readLandingMode(ticket.root);
  } catch (error) {
    if (error instanceof Failure) throw refused(error.message);
    throw error;
  }
  refuseNarrowing(ticket, base, checking);
  const noReview = missingReview(logDirectory(ticket.main), ticket.branch);
  if (noReview !== null) {
    throw new LandingFailure(
      "review-missing",
      `#${ticket.n} did not land: no review of ${ticket.branch} is recorded: ${noReview}. ` +
        `Running verkstad:review on the branch records one.\nBranch ${ticket.branch} is kept as it was, in its worktree.`,
    );
  }
  // gh finds the Project's repo from the directory it runs in, and the worktree is about to go.
  process.chdir(ticket.main);

  const lock = takeLock(ticket);
  try {
    if (mode === "pull-request") landAsPullRequest(ticket, base, report);
    else pushToBase(ticket, base, report);
  } finally {
    closeSync(lock);
  }
}

/**
 * Fails with contract-narrowed, changing nothing, when the branch's Contract checks less than the base's
 * Contract as the branch left it (its merge-base with origin's base branch): the Surfaces decide which
 * Tickets the Verifier Walks, so a Ticket narrowing them would land with less checking than it deserves.
 * Comparing with the fork point, not the latest base, keeps a Surface the owner added since from reading
 * as one the branch removed.
 */
function refuseNarrowing(ticket: Ticket, base: string, checking: Checking): void {
  const forkPoint = git(ticket.root, ["merge-base", "HEAD", `origin/${base}`]).trim();
  const before = committedChecking(ticket.root, forkPoint);
  const found = before === null ? [] : narrowings(before, checking);
  if (found.length === 0) return;
  throw new LandingFailure(
    "contract-narrowed",
    `#${ticket.n} did not land: ${ticket.branch} narrows the Contract: it ${found.join("; ")}.\n` +
      `Branch ${ticket.branch} is kept as it was, in its worktree.`,
  );
}

/**
 * Removes the worktree, the local branch and its review record once the branch is on origin, so that a new
 * issue-<n> needs a review of its own; says what it could not do.
 */
function removeWorktreeAndBranch(ticket: Ticket): string {
  deleteReview(logDirectory(ticket.main), ticket.branch);
  const { notes, removed } = removeWorktree(ticket.main, ticket.root);
  // git deletes no branch a worktree has checked out.
  if (!removed) return `${notes}Branch ${ticket.branch} is kept with it.\n`;
  const deleted = tryGit(ticket.main, ["branch", "--delete", "--force", ticket.branch]).status === 0;
  return notes + (deleted ? "" : `Could not delete the branch ${ticket.branch}.\n`);
}

/** Landing mode push: lands the branch on the base branch and closes the Ticket. */
function pushToBase(ticket: Ticket, base: string, report: string): void {
  const { sha, checked } = rebaseCheckGatePush(ticket, base);
  let closing: Failure | null = null;
  try {
    const comment = `Landed on ${base} in ${sha}.\n\n${report}\n\n${describeGate(checked)}${describeVerification(checked.check)}`;
    gh(["issue", "close", String(ticket.n), "--comment", comment]);
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    closing = error;
  }
  const notes = removeWorktreeAndBranch(ticket) + deleteParkedBranch(ticket) + fastForwardMain(ticket.main, base);
  const dir = logDirectory(ticket.main);
  const pruned = describePruned(dir, pruneLogDirectory(dir));
  if (closing) {
    process.stdout.write(notes + pruned);
    throw new LandingFailure(
      "github-failed",
      `#${ticket.n} landed on ${base} in ${sha}, but closing it failed: ${closing.message}\n` +
        "Close it by hand, with the report and the Verdict as the comment.",
    );
  }
  process.stdout.write(`Landed #${ticket.n} on ${base} in ${sha} and closed it.\n${notes}${pruned}`);
}

/**
 * Landing mode pull-request: force-pushes the rebased branch to origin, over what an earlier Park or
 * Landing put there, and opens a pull request onto the base branch, or updates the one already open.
 * Its body closes the Ticket on merge; until then the Ticket stays open and assigned. The local branch
 * goes with the worktree: the pull request's branch is on origin, and a leftover issue-<n> branch would
 * tell the next Run the Ticket stopped mid-way.
 */
function landAsPullRequest(ticket: Ticket, base: string, report: string): void {
  const checked = rebaseCheckGate(ticket, base);
  const push = tryGit(ticket.root, ["push", "--quiet", "--force", "origin", `HEAD:refs/heads/${ticket.branch}`]);
  if (push.status !== 0) throw didNotLand(ticket, "push-failed", `pushing ${ticket.branch} to origin failed: ${push.stderr.trim()}`);
  const sha = git(ticket.root, ["rev-parse", "--short", "HEAD"]).trim();
  const body = `Closes #${ticket.n}.\n\n${report}\n\n${describeGate(checked)}${describeVerification(checked.check)}`;
  let published: Published | null = null;
  let failed: Failure | null = null;
  try {
    published = publishPullRequest(ticket, base, body);
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    failed = error;
  }
  const notes = removeWorktreeAndBranch(ticket);
  const dir = logDirectory(ticket.main);
  const pruned = describePruned(dir, pruneLogDirectory(dir));
  if (failed || !published) {
    process.stdout.write(notes + pruned);
    throw new LandingFailure(
      "github-failed",
      `#${ticket.n} is on origin as ${ticket.branch} at ${sha}, but opening or updating its pull request failed: ${failed?.message}\n` +
        `Finish by hand: open a pull request from ${ticket.branch} onto ${base}, or update the open one, ` +
        `with "Closes #${ticket.n}.", the report and the Verdict as its body.`,
    );
  }
  const { verb, url } = published;
  process.stdout.write(`${verb} ${url} onto ${base} for #${ticket.n} (${ticket.branch} at ${sha}); #${ticket.n} closes when it merges.\n${notes}${pruned}`);
}

/** The Ticket's pull request, and whether this Landing opened it or updated the open one. */
interface Published {
  verb: "Opened" | "Updated";
  url: string;
}

/** Opens the Ticket's pull request onto the base, titled as the Ticket, or replaces the open one's body. */
function publishPullRequest(ticket: Ticket, base: string, body: string): Published {
  const listing = ["pr", "list", "--head", ticket.branch, "--base", base, "--state", "open", "--json", "number,url"];
  const open = ghJson<Array<{ number: number; url: string }>>(listing);
  if (open.length > 0) {
    gh(["pr", "edit", String(open[0].number), "--body", body]);
    return { verb: "Updated", url: open[0].url };
  }
  const { title } = ghJson<{ title: string }>(["api", `repos/{owner}/{repo}/issues/${ticket.n}`]);
  const created = gh(["pr", "create", "--base", base, "--head", ticket.branch, "--title", title, "--body", body]);
  const url = created.trim().split("\n").at(-1);
  if (!url) throw new Failure("gh pr create printed no pull request URL");
  return { verb: "Opened", url };
}

/**
 * The Ticket to Park: its clean worktree, as for a Landing; or, when a failed Landing already removed the
 * worktree, its kept branch in the Project the command runs in.
 */
function checkTicketBranch(args: Args): TicketBranch {
  if (existsSync(args.worktree)) return checkTicket(args);
  const branch = `issue-${args.n}`;
  const top = tryGit(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const main = top.status === 0 ? mainCheckout(top.stdout.trim()) : null;
  if (main === null || tryGit(main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).status !== 0) {
    throw refused(`no worktree at ${args.worktree}, and no branch ${branch} in the Project here`);
  }
  return { n: args.n, branch, root: null, main };
}

function parkTicket(args: Args): void {
  const ticket = checkTicketBranch(args);
  const why = readFile(args.file, "reason");
  process.chdir(ticket.main);
  const ref = `refs/heads/${ticket.branch}`;
  const sha = git(ticket.main, ["rev-parse", "--short", ref]).trim();
  const push = tryGit(ticket.main, ["push", "--quiet", "--force", "origin", `${ref}:${ref}`]);
  if (push.status !== 0) {
    const what = `#${ticket.n} was not parked: pushing ${ticket.branch} to origin failed: ${push.stderr.trim()}`;
    throw keepBranch(ticket, "push-failed", what);
  }
  const { notes, removed } = ticket.root === null ? { notes: "", removed: false } : removeWorktree(ticket.main, ticket.root);
  const n = String(ticket.n);
  const comment = `${why}\n\nParked: branch \`${ticket.branch}\` is on origin at ${sha}; a Resume continues from it.`;
  for (const call of [
    ["issue", "edit", n, "--remove-label", "ready-for-agent", "--add-label", "needs-info", "--remove-assignee", "@me"],
    ["issue", "comment", n, "--body", comment],
  ]) {
    try {
      gh(call);
    } catch (error) {
      if (!(error instanceof Failure)) throw error;
      const todo = call[1] === "edit" ? "label it needs-info, unassign it and comment why" : "comment why";
      throw new LandingFailure(
        "github-failed",
        `${notes}${ticket.branch} is on origin at ${sha}, but updating #${ticket.n} failed: ${error.message}\n` +
          `Finish by hand: ${todo}.`,
      );
    }
  }
  const worktree = removed ? ", worktree removed" : "";
  process.stdout.write(`${notes}Parked #${ticket.n}: branch ${ticket.branch} pushed to origin${worktree}, labelled needs-info.\n`);
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
