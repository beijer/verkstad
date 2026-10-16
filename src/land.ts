// `verkstad land <n> <worktree> <report-file>`: lands a finished Ticket's
// branch, issue-<n>, on the base branch. Under a lock, so that one Landing runs
// at a time per main checkout, it rebases the branch onto origin's base branch,
// checks the Ticket's Verdict, and runs the full Gate in the worktree, unless a
// full pass on the rebased tree is recorded (src/gate.ts), or the quick Gate when
// the base changed none of the branch's files since its recorded pass. Then, by
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
// `verkstad land --train <n> <n> … <report-dir>`: lands several finished
// Tickets as one Train (ADR 0010), each found in its worktree by its branch,
// with its report in <report-dir>/report-<n>.md. Under the lock it stacks them
// on origin's base branch, in order, in a worktree of its own (train-<first n>),
// checks each Verdict against its own patch in the stack, runs one full Gate
// on the stack and pushes it once, closing each Ticket as a single Landing
// does. A Ticket whose check fails leaves the Train with its reason; the rest go
// on. Push mode only.
//
// `verkstad land --park <n> <worktree> <reason-file>`: Parks the Ticket. Its
// branch goes to origin, its worktree (if a failed Landing left one) is
// removed, it is labelled needs-info, unassigned and told why.
//
// A push that landed, whose close failed, keeps the closing comment in the log
// directory (close-<n>.md) for a Run, or the owner, to close the Ticket with.
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
import { closeSync, existsSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Checking, committedChecking, type LandingMode, narrowings, readChecking, readContract, readLandingMode } from "./contract.ts";
import { Failure } from "./fail.ts";
import { recordedPass, recordedPassDetails, runGate, StepFailure } from "./gate.ts";
import { gh, ghJson } from "./gh.ts";
import { commonDir, type GitResult, git, logDirectory, mainCheckout, tryFetch, tryGit } from "./git.ts";
import { describePruned, pruneLogDirectory } from "./prune.ts";
import { deleteReview, missingReview } from "./review.ts";
import { checkVerdict, describeVerification, type VerdictCheck, type VerdictReason } from "./verdict.ts";

const USAGE =
  "usage: verkstad land <n> <worktree> <report-file> | verkstad land --park <n> <worktree> <reason-file> | " +
  "verkstad land --train <n> <n> … <report-dir>";
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
  reason: Reason;
  /** The message without its reason line. */
  detail: string;

  constructor(reason: Reason, message: string) {
    super(`${message}\nreason: ${reason}`, reason === "refused" ? 2 : 1);
    this.reason = reason;
    this.detail = message;
  }
}

/** Where a Landing that pushed but could not close Ticket #n keeps the comment it would have closed it with. */
export function closingCommentPath(logDir: string, n: number): string {
  return join(logDir, `close-${n}.md`);
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

function fetchBase(cwd: string, base: string): void {
  const r = tryFetch(cwd, [base]);
  if (r.status !== 0) throw new Failure(`could not fetch origin/${base}: ${r.stderr.trim()}`);
}

/** What a Landing pushed: the landed commit, abbreviated, and what the rebased branch passed. */
interface Landed {
  sha: string;
  checked: Checked;
}

/**
 * What a rebased branch passed: the Verdict check, the tree whose recorded Gate pass stood in for the Gate,
 * the log of the full pass a quick Gate stood on, and the failed first run when the Gate passed only when
 * run once more.
 */
interface Checked {
  check: VerdictCheck;
  reused: string | null;
  quickOn: string | null;
  firstFailure: StepFailure | null;
}

/**
 * The line a Landing's comment carries when it reused a recorded Gate pass, or when the Gate passed only
 * on its second run; none when the Gate passed at once.
 */
function describeGate({ reused, quickOn, firstFailure }: Checked): string {
  if (reused !== null) return `The Gate was not run again: a full pass on this tree (${reused}) was recorded before.\n`;
  const quick = quickOn === null ? "" : `Landed on a quick Gate: the base changed none of this Ticket's files since its full Gate pass (log: ${quickOn}).\n`;
  if (firstFailure !== null) return `${quick}The first Gate run failed at ${firstFailure.step} (log: ${firstFailure.log}); the second passed.\n`;
  return quick;
}

/** The files changed between two commits, renames as a deletion and an addition; null when git cannot tell. */
function filesChanged(root: string, from: string, to: string): Set<string> | null {
  const r = tryGit(root, ["diff", "-z", "--name-only", "--no-renames", from, to, "--"]);
  return r.status === 0 ? new Set(r.stdout.split("\0").filter(Boolean)) : null;
}

/**
 * The log of the full pass recorded before the rebase when the base changed, since the base that pass was
 * taken on, none of the files the branch changed: a quick Gate is then enough. Otherwise null.
 */
function quickGateOn(root: string, upstream: string, log: string): string | null {
  const { base } = recordedPassDetails(root);
  if (base === null) return null;
  const branch = filesChanged(root, base, "HEAD");
  const moved = filesChanged(root, base, upstream);
  if (branch === null || moved === null) return null;
  return [...moved].some((f) => branch.has(f)) ? null : log;
}

/** Aborts the rebase that failed in `root` and says how: the conflicting files, or git's complaint. */
function abortRebase(root: string, rebase: GitResult): string {
  const unmerged = tryGit(root, ["diff", "-z", "--name-only", "--diff-filter=U"]).stdout.split("\0").filter(Boolean);
  tryGit(root, ["rebase", "--abort"]);
  return unmerged.length ? `conflicts in ${unmerged.join(", ")}.` : `failed: ${rebase.stderr.trim()}`;
}

/**
 * Fetches the base, rebases the branch onto it, checks the Verdict, and runs the full Gate, unless a full
 * pass on the rebased tree is recorded; a failure throws.
 */
function rebaseCheckGate(ticket: Ticket, base: string): Checked {
  const upstream = `origin/${base}`;
  fetchBase(ticket.root, base);
  // A full pass on the branch as it stands, before the rebase: when the Gate fails below, the Ticket's own
  // tree passed, so the failure may be a flaky test, and the Gate runs once more before it ends gate-failed.
  const passedBefore = recordedPass(ticket.root) === null ? null : (recordedPassDetails(ticket.root).log ?? "its log is unknown");
  const quickOn = passedBefore === null ? null : quickGateOn(ticket.root, upstream, passedBefore);
  const rebase = tryGit(ticket.root, ["rebase", "--quiet", upstream]);
  if (rebase.status !== 0) {
    const how = abortRebase(ticket.root, rebase);
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
    return { check, reused, quickOn: null, firstFailure: null };
  }
  if (quickOn !== null) {
    process.stdout.write(
      `The base changed none of the files ${ticket.branch} changed since its full Gate pass (log: ${quickOn}); running the quick Gate.\n`,
    );
  }
  let firstFailure: StepFailure | null = null;
  // At most two runs: only a failing step on a tree that passed before the rebase runs once more, since it
  // may be a flaky test.
  for (;;) {
    try {
      runGate(ticket.root, quickOn !== null);
      return { check, reused: null, quickOn, firstFailure };
    } catch (error) {
      if (!(error instanceof Failure)) throw error;
      if (firstFailure !== null) {
        const first = `the first run failed at ${firstFailure.step}, log: ${firstFailure.log}`;
        throw didNotLand(ticket, "gate-failed", `the Gate failed again when run once more (${first}): ${error.message}`);
      }
      // A Repeat step's failure is not run once more: repetition is its proof.
      if (passedBefore === null || !(error instanceof StepFailure) || error.repeated) {
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
    fetchBase(ticket.root, base);
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
  refuseUnreviewed(ticket);
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

/** Fails with review-missing, changing nothing, when no review of the branch is recorded. */
function refuseUnreviewed(ticket: Ticket): void {
  const noReview = missingReview(logDirectory(ticket.main), ticket.branch);
  if (noReview === null) return;
  throw new LandingFailure(
    "review-missing",
    `#${ticket.n} did not land: no review of ${ticket.branch} is recorded: ${noReview}. ` +
      `Running verkstad:review on the branch records one.\nBranch ${ticket.branch} is kept as it was, in its worktree.`,
  );
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

/**
 * Closes the Ticket that landed in `sha` with its report and Verdict; when GitHub refuses, keeps the comment
 * in the log directory and returns the github-failed failure to end with.
 */
function closeLanded(ticket: Ticket, base: string, sha: string, report: string, checked: Checked): LandingFailure | null {
  const comment = `Landed on ${base} in ${sha}.\n\n${report}\n\n${describeGate(checked)}${describeVerification(checked.check)}`;
  try {
    gh(["issue", "close", String(ticket.n), "--comment", comment]);
    return null;
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    // Kept for whoever closes it: a Run, once GitHub lets it, or the owner.
    const kept = closingCommentPath(logDirectory(ticket.main), ticket.n);
    let byHand = `with ${kept} as the comment`;
    try {
      writeFileSync(kept, comment);
    } catch (e) {
      byHand = `with the report and the Verdict as the comment (keeping it in ${kept} failed: ${(e as Error).message})`;
    }
    return new LandingFailure(
      "github-failed",
      `#${ticket.n} landed on ${base} in ${sha}, but closing it failed: ${error.message}\nClose it by hand, ${byHand}.`,
    );
  }
}

/** Landing mode push: lands the branch on the base branch and closes the Ticket. */
function pushToBase(ticket: Ticket, base: string, report: string): void {
  const { sha, checked } = rebaseCheckGatePush(ticket, base);
  const closing = closeLanded(ticket, base, sha, report, checked);
  const notes = removeWorktreeAndBranch(ticket) + deleteParkedBranch(ticket) + fastForwardMain(ticket.main, base);
  const dir = logDirectory(ticket.main);
  const pruned = describePruned(dir, pruneLogDirectory(dir));
  if (closing) {
    process.stdout.write(notes + pruned);
    throw closing;
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

/** A Ticket in a Train: its report, and, while it is in the stack, its last commit there and its Verdict check. */
interface Rider {
  ticket: Ticket;
  report: string;
  stacked: { sha: string; check: VerdictCheck } | null;
  /** Why it left the Train; a Verdict reason is told once its worktree is rebased. */
  left: LandingFailure | null;
  verdict: { reason: VerdictReason; message: string } | null;
}

/** Each branch's worktree in the Project the command runs in, by branch name. */
function branchWorktrees(): Map<string, string> {
  const r = tryGit(process.cwd(), ["worktree", "list", "--porcelain", "-z"]);
  if (r.status !== 0) throw refused(`${process.cwd()} is not in a git checkout`);
  const found = new Map<string, string>();
  let path = "";
  for (const line of r.stdout.split("\0")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line.startsWith("branch refs/heads/")) found.set(line.slice("branch refs/heads/".length), path);
  }
  return found;
}

function readTrain(args: string[]): Rider[] {
  const ns = args.slice(0, -1);
  if (ns.length < 2 || !ns.every((n) => /^[1-9]\d*$/.test(n))) throw refused(USAGE);
  if (new Set(ns).size !== ns.length) throw refused(`a Train names each Ticket once, not ${ns.join(" ")}`);
  const reports = resolve(args.at(-1) as string);
  const worktrees = branchWorktrees();
  return ns.map(Number).map((n) => {
    const worktree = worktrees.get(`issue-${n}`);
    if (worktree === undefined) throw refused(`#${n} has no worktree on issue-${n}`);
    const ticket = checkTicket({ park: false, n, worktree, file: "" });
    const report = readFile(join(reports, `report-${n}.md`), "report");
    return { ticket, report, stacked: null, left: null, verdict: null };
  });
}

/**
 * Stacks the rider's branch on the Train's HEAD in `root`: its commits since it left `upstream`, rebased.
 * A conflict, nothing to land or a failed Verdict check for its own patch in the stack makes it leave the
 * Train, and the stack goes back to where it was.
 */
function stack(root: string, rider: Rider, upstream: string, ahead: number[]): void {
  const { ticket } = rider;
  rider.stacked = null;
  const before = git(root, ["rev-parse", "HEAD"]).trim();
  const tip = git(root, ["rev-parse", ticket.branch]).trim();
  const back = () => git(root, ["checkout", "--quiet", "--detach", before]);
  const rebase = tryGit(root, ["rebase", "--quiet", "--onto", before, upstream, tip]);
  if (rebase.status !== 0) {
    const how = abortRebase(root, rebase);
    back();
    const onto = ahead.length ? `${ahead.map((n) => `#${n}`).join(", ")} on ${upstream}` : upstream;
    rider.left = didNotLand(ticket, "conflict", `stacking ${ticket.branch} onto ${onto} ${how}`, true);
    return;
  }
  if (git(root, ["rev-list", "--count", `${before}..HEAD`]).trim() === "0") {
    back();
    rider.left = didNotLand(ticket, "no-commits", `${ticket.branch} has no commits that are not on ${upstream}.`);
    return;
  }
  const check = checkVerdict(root, ticket.n, before);
  if (check.failure) {
    back();
    rider.verdict = check.failure;
    return;
  }
  rider.stacked = { sha: git(root, ["rev-parse", "HEAD"]).trim(), check };
}

/** Takes each stacked rider out of the Train with the failure `leave` makes for its Ticket. */
function unstack(riders: Rider[], leave: (ticket: Ticket) => LandingFailure): void {
  for (const r of riders.filter((r) => r.stacked)) {
    r.left = leave(r.ticket);
    r.stacked = null;
  }
}

/**
 * Stacks the riders still in the Train on origin's base in `root`, gates the stack once and pushes it,
 * restacking when the base moved during the Gate. Returns the tree whose recorded pass stood in for the
 * Gate; on a push every rider still stacked landed.
 */
function stackGatePush(root: string, riders: Rider[], first: Ticket, base: string): string | null {
  const upstream = `origin/${base}`;
  for (let attempt = 1; ; attempt++) {
    fetchBase(first.main, base);
    git(root, ["checkout", "--quiet", "--detach", upstream]);
    const ahead: number[] = [];
    for (const r of riders.filter((r) => r.left === null && r.verdict === null)) {
      stack(root, r, upstream, ahead);
      if (r.stacked) ahead.push(r.ticket.n);
    }
    if (ahead.length === 0) return null;
    const reused = recordedPass(root);
    if (reused !== null) process.stdout.write(`Reused the full Gate pass recorded for tree ${reused}; no step ran.\n`);
    else {
      try {
        runGate(root, false);
      } catch (error) {
        if (!(error instanceof Failure)) throw error;
        unstack(riders, (t) => didNotLand(t, "gate-failed", `the Train's Gate failed: ${error.message}`, true));
        return null;
      }
    }
    const push = tryGit(root, ["push", "--quiet", "origin", `HEAD:refs/heads/${base}`]);
    if (push.status === 0) return reused;
    fetchBase(first.main, base);
    const moved = tryGit(root, ["merge-base", "--is-ancestor", upstream, "HEAD"]).status !== 0;
    const pushFailed = (detail: string) => (t: Ticket) =>
      new LandingFailure("push-failed", `#${t.n} did not land: ${detail}\nBranch ${t.branch} is kept as it was, in its worktree.`);
    if (!moved) {
      unstack(riders, pushFailed(`pushing the Train to ${upstream} failed: ${push.stderr.trim()}`));
      return null;
    }
    if (attempt === ATTEMPTS) {
      unstack(riders, pushFailed(`${upstream} moved during each of ${ATTEMPTS} Gate runs.`));
      return null;
    }
    process.stdout.write(`${upstream} moved during the Gate; stacking the Train again (attempt ${attempt + 1} of ${ATTEMPTS}).\n`);
  }
}

/** Closes a landed rider's Ticket with its report and Verdict, and removes its worktree and branch; returns notes. */
function closeRider(r: Rider, base: string, reused: string | null): string {
  const { ticket } = r;
  const { sha, check } = r.stacked as { sha: string; check: VerdictCheck };
  const short = git(ticket.main, ["rev-parse", "--short", sha]).trim();
  r.left = closeLanded(ticket, base, short, r.report, { check, reused, quickOn: null, firstFailure: null });
  return removeWorktreeAndBranch(ticket) + deleteParkedBranch(ticket);
}

/** Rebases the worktree of a rider whose Verdict check failed onto origin's base as the Train left it, for the Verifier. */
function rebaseForVerifier(r: Rider, base: string): void {
  const { ticket } = r;
  const { reason, message } = r.verdict as { reason: VerdictReason; message: string };
  const rebase = tryGit(ticket.root, ["rebase", "--quiet", `origin/${base}`]);
  if (rebase.status !== 0) tryGit(ticket.root, ["rebase", "--abort"]);
  const kept = rebase.status === 0 ? `rebased onto origin/${base}` : `as it was (rebasing it onto origin/${base} failed)`;
  r.left = new LandingFailure(reason, `#${ticket.n} did not land: ${message}\nBranch ${ticket.branch} is kept, ${kept}, in its worktree.`);
}

/**
 * `land --train`: lands several finished Tickets as one Landing behind one Gate (ADR 0010), stacked in a
 * worktree of their own; a Ticket whose check fails leaves the Train with its reason. Returns whether every
 * Ticket landed.
 */
function landTrain(args: string[]): boolean {
  const riders = readTrain(args);
  const first = riders[0].ticket;
  let base: string;
  let checkings: Checking[];
  try {
    base = readContract(first.root).baseBranch;
    if (readLandingMode(first.root) === "pull-request") throw new Failure("a Train lands only in the push Landing mode, not pull-request");
    checkings = riders.map((r) => readChecking(r.ticket.root));
  } catch (error) {
    if (error instanceof Failure) throw refused(error.message);
    throw error;
  }
  for (const [i, r] of riders.entries()) {
    try {
      refuseNarrowing(r.ticket, base, checkings[i]);
      refuseUnreviewed(r.ticket);
    } catch (error) {
      if (!(error instanceof LandingFailure)) throw error;
      r.left = error;
    }
  }
  process.chdir(first.main);

  const lock = takeLock(first);
  let notes = "";
  try {
    const root = join(first.main, ".claude", "worktrees", `train-${first.n}`);
    // Under the lock no other Train runs, so a worktree already there is a stopped Train's.
    if (existsSync(root)) notes += removeWorktree(first.main, root).notes;
    fetchBase(first.main, base);
    git(first.main, ["worktree", "add", "--quiet", "--detach", root, `origin/${base}`]);
    try {
      const reused = stackGatePush(root, riders, first, base);
      for (const r of riders) if (r.stacked) notes += closeRider(r, base, reused);
    } finally {
      notes += removeWorktree(first.main, root).notes;
    }
    for (const r of riders) if (r.verdict) rebaseForVerifier(r, base);
    if (riders.some((r) => r.stacked)) notes += fastForwardMain(first.main, base);
  } finally {
    closeSync(lock);
  }
  const dir = logDirectory(first.main);
  const lines = riders.map((r) =>
    r.left ? `#${r.ticket.n}: reason: ${r.left.reason}\n${r.left.detail}\n` : `#${r.ticket.n}: landed on ${base} in ${git(first.main, ["rev-parse", "--short", r.stacked?.sha as string]).trim()}\n`,
  );
  process.stdout.write(notes + describePruned(dir, pruneLogDirectory(dir)) + lines.join(""));
  return riders.every((r) => r.left === null);
}

export function land(args: string[]): void {
  let landed = true;
  try {
    if (args[0] === "--train") {
      landed = landTrain(args.slice(1));
    } else {
      const parsed = parseArgs(args);
      if (parsed.park) parkTicket(parsed);
      else landTicket(parsed);
    }
  } catch (error) {
    if (error instanceof Failure && !(error instanceof LandingFailure)) throw new LandingFailure("error", error.message);
    throw error;
  }
  if (!landed) throw new Failure("not every Ticket of the Train landed");
}
