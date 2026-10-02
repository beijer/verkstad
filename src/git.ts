// verkstad's way to git, and where a checkout's parts are.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { Failure } from "./fail.ts";

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs git in `cwd` and returns what it did, failing only when git cannot run at all. */
export function tryGit(cwd: string, args: string[]): GitResult {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Failure(`could not run git: ${r.error.message}`);
  return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

/** Runs git in `cwd` and returns its stdout, failing with git's complaint on a non-zero exit. */
export function git(cwd: string, args: string[]): string {
  const r = tryGit(cwd, args);
  if (r.status !== 0) throw new Failure(`git ${args[0]} failed: ${r.stderr.trim() || `exit ${r.status}`}`);
  return r.stdout;
}

/** The root of the checkout or worktree `cwd` is in. */
export function worktreeRoot(cwd: string): string {
  const r = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (r.status !== 0) throw new Failure(`not in a git checkout: ${cwd}`);
  return r.stdout.trim();
}

/** The Project's main checkout, found from any of its worktrees. */
export function mainCheckout(cwd: string): string {
  return dirname(git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim());
}

/** The log directory, `<main checkout>/.claude/verkstad/`: gitignored and outside every worktree. */
export function logDirectory(cwd: string): string {
  return join(mainCheckout(cwd), ".claude", "verkstad");
}
