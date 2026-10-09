// verkstad's way to git, and where a checkout's parts are.

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Failure } from "./fail.ts";

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs git in `cwd`, with `input` on its stdin, and returns what it did, failing only when git cannot run at all. */
export function tryGit(cwd: string, args: string[], input?: string): GitResult {
  const r = spawnSync("git", args, { cwd, input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Failure(`could not run git: ${r.error.message}`);
  return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

/** Runs git in `cwd` and returns its stdout, failing with git's complaint on a non-zero exit. */
export function git(cwd: string, args: string[]): string {
  const r = tryGit(cwd, args);
  if (r.status !== 0) throw new Failure(`git ${args[0]} failed: ${r.stderr.trim() || `exit ${r.status}`}`);
  return r.stdout;
}

const FETCH_ATTEMPTS = 5;

/**
 * Fetches `refs` (every branch when none) from origin into the remote-tracking refs every worktree shares,
 * and returns what the last attempt did. Another worktree's fetch may hold a ref's lock or
 * move the ref under this one, so a failed fetch is tried again, a little later each time.
 */
export function tryFetch(cwd: string, refs: string[] = []): GitResult {
  for (let attempt = 1; ; attempt++) {
    const r = tryGit(cwd, ["fetch", "--quiet", "origin", ...refs]);
    if (r.status === 0 || attempt === FETCH_ATTEMPTS) return r;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * attempt);
  }
}

/** Fetches as `tryFetch` does, failing as `git` does when the last attempt fails. */
export function fetch(cwd: string, refs: string[] = []): void {
  const r = tryFetch(cwd, refs);
  if (r.status !== 0) throw new Failure(`git fetch failed: ${r.stderr.trim() || `exit ${r.status}`}`);
}

/** The root of the checkout or worktree `cwd` is in. */
export function worktreeRoot(cwd: string): string {
  const r = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (r.status !== 0) throw new Failure(`not in a git checkout: ${cwd}`);
  return r.stdout.trim();
}

/** The git directory every worktree of the Project shares: the main checkout's `.git`. */
export function commonDir(cwd: string): string {
  return git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
}

/** The Project's main checkout, found from any of its worktrees. */
export function mainCheckout(cwd: string): string {
  return dirname(commonDir(cwd));
}

/**
 * Whether `cwd` is in a linked worktree of its repo, as an agent's is, rather than its main checkout
 * or a submodule's checkout: false outside git.
 */
export function inLinkedWorktree(cwd: string): boolean {
  const r = tryGit(cwd, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]);
  if (r.status !== 0) return false;
  const [gitDir, common] = r.stdout.trim().split("\n");
  return gitDir !== common;
}

/** The log directory, `<main checkout>/.claude/verkstad/`: gitignored and outside every worktree. */
export function logDirectory(cwd: string): string {
  return join(mainCheckout(cwd), ".claude", "verkstad");
}

/**
 * Creates the log directory and returns it, failing unless git ignores it, so that nothing in it is ever
 * committed: in the main checkout, or in the worktree at `root` whose branch adds it to .gitignore and has
 * not landed yet.
 */
export function ensureLogDirectory(root: string): string {
  const dir = logDirectory(root);
  const ignored = (cwd: string) => tryGit(cwd, ["check-ignore", "-q", ".claude/verkstad/"]).status === 0;
  if (!ignored(root) && !ignored(mainCheckout(root))) {
    throw new Failure(`the log directory ${dir}/ is not gitignored; add .claude/verkstad/ to the Project's .gitignore`);
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}
