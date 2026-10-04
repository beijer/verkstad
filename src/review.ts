// `verkstad review record`: records that verkstad:review ran on the branch the
// worktree it runs in is on, as `review-<branch>.json` in the log directory:
// the branch and the commit HEAD was on. Landing fails on a Ticket's branch
// with no recorded review (`reason: review-missing`), changing nothing. Any review of the branch
// counts, whatever commit it was on: the implementer commits its fixes after
// the review, and a rebase rewrites every commit anyway. A Landing that puts
// the branch on origin deletes its record with the branch.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isObject } from "./contract.ts";
import { Failure } from "./fail.ts";
import { ensureLogDirectory, git, worktreeRoot } from "./git.ts";

const USAGE = "usage: verkstad review record";

/** The file `review-<branch>.json` in the log directory. */
interface ReviewRecord {
  branch: string;
  /** The full SHA HEAD was on when the review was recorded. */
  commit: string;
  /** When the review was recorded, as an ISO 8601 time. */
  recordedAt: string;
}

/** Where the review of `branch` is recorded in the log directory `dir`; a slash in the branch is escaped. */
function reviewPath(dir: string, branch: string): string {
  return join(dir, `review-${encodeURIComponent(branch)}.json`);
}

/** Why `branch` has no recorded review in the log directory `dir`, or null when it has one. */
export function missingReview(dir: string, branch: string): string | null {
  const path = reviewPath(dir, branch);
  if (!existsSync(path)) return `there is no ${path}`;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return `${path} is not valid JSON: ${(error as Error).message}`;
  }
  if (!isObject(value)) return `${path} is not a JSON object`;
  if (value.branch !== branch) return `${path} names the branch ${JSON.stringify(value.branch)}, not ${branch}`;
  if (typeof value.commit !== "string" || !/^[0-9a-f]{40,64}$/.test(value.commit)) {
    return `${path} names no commit: its commit is ${JSON.stringify(value.commit)}`;
  }
  return null;
}

/** Deletes the review recorded for `branch`, if there is one. */
export function deleteReview(dir: string, branch: string): void {
  rmSync(reviewPath(dir, branch), { force: true });
}

function record(): void {
  const root = worktreeRoot(process.cwd());
  const branch = git(root, ["branch", "--show-current"]).trim();
  if (!branch) throw new Failure("HEAD is detached; a review is recorded for the branch it reviewed, so switch to it first");
  const commit = git(root, ["rev-parse", "HEAD"]).trim();
  const path = reviewPath(ensureLogDirectory(root), branch);
  const recorded: ReviewRecord = { branch, commit, recordedAt: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(recorded, null, 2) + "\n");
  const short = git(root, ["rev-parse", "--short", "HEAD"]).trim();
  process.stdout.write(`Recorded a review of ${branch} at ${short} in ${path}.\n`);
}

export function review(args: string[]): void {
  if (args.length !== 1 || args[0] !== "record") throw new Failure(USAGE, 2);
  record();
}
