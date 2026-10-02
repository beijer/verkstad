// `verkstad verdict record|check|evidence`: the Verifier's Verdict for a Ticket,
// kept as `verdict-<n>.json` in the log directory (docs/verdict.md).
//
// A Verdict holds for the patch it was given for: `record` computes the
// patch-id of the branch's diff since it left origin's base branch, and `check`
// accepts the Verdict only while the branch's diff has the same patch-id, so a
// clean rebase keeps it and a conflict resolution that changed the patch voids
// it (ADR 0005). `check` passes outright for a branch that touches no Surface
// (ADR 0004). Landing runs the check after its Gate.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isObject, readContract, readSurfaces } from "./contract.ts";
import { Failure } from "./fail.ts";
import { ensureLogDirectory, git, logDirectory, tryGit, worktreeRoot } from "./git.ts";
import { branchPoint, describeSurfaces, type TouchedSurface, touchedSurfaces } from "./surfaces.ts";

const USAGE = [
  "usage: verkstad verdict record <n> <worktree> --state <state> --criteria <file>",
  "       verkstad verdict check <n> <worktree>",
  "       verkstad verdict evidence <n>",
].join("\n");

export const STATES = ["live-verified", "test-verified", "blocked", "failed"] as const;
/** How far a Ticket was proven. */
export type VerificationState = (typeof STATES)[number];

/** What the Verifier saw for one acceptance criterion. */
export interface CriterionSeen {
  criterion: string;
  seen: string;
}

/** The file `verdict-<n>.json` in the log directory, as docs/verdict.md describes it. */
export interface Verdict {
  ticket: number;
  state: VerificationState;
  /** `git patch-id --stable` of the branch's diff when the Verdict was recorded. */
  patchId: string;
  criteria: CriterionSeen[];
  /** The Evidence directory, an absolute path in the log directory. */
  evidence: string;
  /** When the Verdict was recorded, as an ISO 8601 time. */
  recordedAt: string;
}

/** Why a Verdict check fails, as Landing's reason says. */
export type VerdictReason = "verdict-missing" | "verdict-not-live" | "verdict-void";

export interface VerdictCheck {
  touched: TouchedSurface[];
  /** The Ticket's Verdict when it was given for the branch's current patch, else null. */
  verdict: Verdict | null;
  /** What `check` prints when it passes. */
  passed?: string;
  failure?: { reason: VerdictReason; message: string };
}

export function verdictPath(dir: string, n: number): string {
  return join(dir, `verdict-${n}.json`);
}

export function evidencePath(dir: string, n: number): string {
  return join(dir, `evidence-${n}`);
}

/**
 * The patch-id of the branch's committed diff since `since`, or null when it has none. The diff's options are
 * spelled out so that a user's diff configuration cannot give the same patch two ids.
 */
export function patchId(root: string, since: string): string | null {
  const diff = git(root, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-relative",
    "--no-renames",
    "--binary",
    "--diff-algorithm=myers",
    "--indent-heuristic",
    "--inter-hunk-context=0",
    "-U3",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    since,
    "HEAD",
  ]);
  if (diff === "") return null;
  const r = tryGit(root, ["patch-id", "--stable"], diff);
  if (r.status !== 0) throw new Failure(`git patch-id failed: ${r.stderr.trim()}`);
  return r.stdout.split(" ")[0] || null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** The criteria as the Verifier wrote them, or what is wrong with them. */
function parseCriteria(value: unknown): CriterionSeen[] | string {
  if (!Array.isArray(value) || value.length === 0) return "criteria must be a non-empty array";
  for (const [i, c] of value.entries()) {
    if (!isObject(c) || !nonEmpty(c.criterion) || !nonEmpty(c.seen)) {
      return `criteria[${i}] must be an object with a non-empty criterion and seen`;
    }
  }
  return value.map((c) => ({ criterion: c.criterion, seen: c.seen }));
}

/** Reads `verdict-<n>.json`: null when there is none, a string saying what is wrong with a malformed one. */
function readVerdict(path: string, n: number): Verdict | string | null {
  if (!existsSync(path)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return `it is not valid JSON: ${(error as Error).message}`;
  }
  if (!isObject(value)) return "it is not a JSON object";
  if (value.ticket !== n) return `its ticket is ${JSON.stringify(value.ticket)}, not ${n}`;
  if (!STATES.includes(value.state as VerificationState)) return `its state must be one of ${STATES.join(", ")}`;
  if (typeof value.patchId !== "string" || !/^[0-9a-f]{40,64}$/.test(value.patchId)) return "its patchId is not a patch-id";
  const criteria = parseCriteria(value.criteria);
  if (typeof criteria === "string") return `its ${criteria}`;
  if (!nonEmpty(value.evidence)) return "its evidence must be a path";
  if (!nonEmpty(value.recordedAt)) return "its recordedAt must be a time";
  return {
    ticket: n,
    state: value.state as VerificationState,
    patchId: value.patchId,
    criteria,
    evidence: value.evidence,
    recordedAt: value.recordedAt,
  };
}

/**
 * Checks Ticket #n's Verdict against the branch checked out at `root`, whose changes are counted from where
 * it left `base` (origin's base branch, as last fetched): passes when the branch touches no Surface, or when
 * its Verdict is `live-verified` for the branch's patch. A Verdict for another patch is void, whatever its state.
 */
export function checkVerdict(root: string, n: number, base: string): VerdictCheck {
  const since = branchPoint(root, base);
  const touched = touchedSurfaces(root, readSurfaces(root), since);
  const path = verdictPath(logDirectory(root), n);
  const read = readVerdict(path, n);
  const recorded = read !== null && typeof read !== "string" ? read : null;
  const patch = recorded ? patchId(root, since) : null;
  const verdict = recorded?.patchId === patch ? recorded : null;

  if (touched.length === 0) return { touched, verdict, passed: `#${n} touches no Surface, so it needs no Verdict.` };
  const touches = `#${n} touches ${describeSurfaces(touched)}`;
  const fail = (reason: VerdictReason, message: string): VerdictCheck => ({ touched, verdict, failure: { reason, message } });
  if (read === null) return fail("verdict-missing", `${touches}, and has no Verdict: there is no ${path}.`);
  if (typeof read === "string") return fail("verdict-missing", `${touches}, and its Verdict ${path} is not one: ${read}.`);
  if (verdict === null) {
    return fail(
      "verdict-void",
      `${touches}, and its Verdict is void: it was given for patch ${read.patchId.slice(0, 12)}, ` +
        `but the branch is now patch ${patch?.slice(0, 12) ?? "(none)"}. The changed patch needs a new Verdict.`,
    );
  }
  if (verdict.state !== "live-verified") {
    return fail("verdict-not-live", `${touches}, and its Verdict is ${verdict.state}, not live-verified.`);
  }
  return { touched, verdict, passed: `${touches}; its Verdict is live-verified for this patch.` };
}

/**
 * The lines Landing's closing comment ends with: how far the landed Ticket was proven, and its Verdict if it
 * has one for the landed patch. Only a `live-verified` Verdict makes it more than `test-verified`; a Ticket
 * touching no Surface lands whatever its Verdict says, and the comment shows that Verdict as it was.
 */
export function describeVerification(check: VerdictCheck): string {
  const surfaces = check.touched.length ? check.touched.map((s) => s.name).join(", ") : "none";
  const v = check.verdict;
  if (v === null) return `Verification state: test-verified. Surfaces: ${surfaces}.\n`;
  const oneLine = (text: string) => text.trim().replace(/\s*\n\s*/g, " ");
  const criteria = v.criteria.map((c) => `- ${oneLine(c.criterion)}: ${oneLine(c.seen)}\n`).join("");
  const evidence = `Evidence: \`${v.evidence}\`.`;
  if (v.state === "live-verified") return `Verification state: live-verified. Surfaces: ${surfaces}. ${evidence}\n\n${criteria}`;
  return `Verification state: test-verified. Surfaces: ${surfaces}. The Verifier's Verdict for this patch was ${v.state}. ${evidence}\n\n${criteria}`;
}

function ticketNumber(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) throw new Failure(USAGE, 2);
  return Number(value);
}

/** The root of the worktree at `path`, checked to be on Ticket #n's branch. */
function ticketWorktree(path: string, n: number): string {
  const worktree = resolve(path);
  if (!existsSync(worktree) || !statSync(worktree).isDirectory()) throw new Failure(`no worktree at ${worktree}`);
  const top = tryGit(worktree, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) throw new Failure(`${worktree} is not in a git worktree`);
  const root = top.stdout.trim();
  const branch = git(root, ["branch", "--show-current"]).trim();
  if (branch !== `issue-${n}`) {
    throw new Failure(`${worktree} is on ${branch ? `branch ${branch}` : "a detached HEAD"}, not issue-${n}`);
  }
  return root;
}

function record(args: string[]): void {
  const [nArg, worktree, ...options] = args;
  const n = ticketNumber(nArg);
  if (worktree === undefined) throw new Failure(USAGE, 2);
  let state: string | undefined;
  let criteriaFile: string | undefined;
  for (let i = 0; i < options.length; i += 2) {
    const [option, value] = [options[i], options[i + 1]];
    if (value === undefined) throw new Failure(USAGE, 2);
    if (option === "--state") state = value;
    else if (option === "--criteria") criteriaFile = value;
    else throw new Failure(`unknown option '${option}'; ${USAGE}`, 2);
  }
  if (state === undefined || criteriaFile === undefined) throw new Failure(USAGE, 2);
  if (!STATES.includes(state as VerificationState)) {
    throw new Failure(`--state must be one of ${STATES.join(", ")}, not '${state}'`, 2);
  }

  const root = ticketWorktree(worktree, n);
  const criteriaPath = resolve(criteriaFile);
  if (!existsSync(criteriaPath)) throw new Failure(`no criteria file at ${criteriaPath}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(criteriaPath, "utf8"));
  } catch (error) {
    throw new Failure(`the criteria file ${criteriaPath} is not valid JSON: ${(error as Error).message}`);
  }
  const criteria = parseCriteria(parsed);
  if (typeof criteria === "string") throw new Failure(`the criteria file ${criteriaPath}: ${criteria}`);
  if (git(root, ["status", "--porcelain", "--untracked-files=no"]).trim() !== "") {
    throw new Failure(`${root} has uncommitted changes, so what was Walked is not the branch's patch; commit or discard them`);
  }
  const base = `origin/${readContract(root).baseBranch}`;
  const patch = patchId(root, branchPoint(root, base));
  if (patch === null) throw new Failure(`issue-${n} has no changes since it left ${base}, so there is no patch to give a Verdict for`);

  const dir = ensureLogDirectory(root);
  const evidence = evidencePath(dir, n);
  mkdirSync(evidence, { recursive: true });
  const verdict: Verdict = {
    ticket: n,
    state: state as VerificationState,
    patchId: patch,
    criteria,
    evidence,
    recordedAt: new Date().toISOString(),
  };
  const path = verdictPath(dir, n);
  writeFileSync(path, JSON.stringify(verdict, null, 2) + "\n");
  const count = criteria.length === 1 ? "1 criterion" : `${criteria.length} criteria`;
  process.stdout.write(`Recorded #${n}'s Verdict: ${state} for patch ${patch.slice(0, 12)}, ${count}, in ${path}\n`);
}

function check(args: string[]): void {
  if (args.length !== 2) throw new Failure(USAGE, 2);
  const n = ticketNumber(args[0]);
  const root = ticketWorktree(args[1], n);
  const result = checkVerdict(root, n, `origin/${readContract(root).baseBranch}`);
  if (result.failure) throw new Failure(`${result.failure.message}\nreason: ${result.failure.reason}`);
  process.stdout.write(`${result.passed}\n`);
}

function evidence(args: string[]): void {
  if (args.length !== 1) throw new Failure(USAGE, 2);
  const n = ticketNumber(args[0]);
  const dir = evidencePath(ensureLogDirectory(worktreeRoot(process.cwd())), n);
  mkdirSync(dir, { recursive: true });
  process.stdout.write(`${dir}\n`);
}

export function verdict(args: string[]): void {
  const [action, ...rest] = args;
  if (action === "record") record(rest);
  else if (action === "check") check(rest);
  else if (action === "evidence") evidence(rest);
  else throw new Failure(USAGE, 2);
}
