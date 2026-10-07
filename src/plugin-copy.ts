// Whether the plugin copy this CLI runs from is behind verkstad's own main, so
// that the owner updates it before agents work from stale skills and prompts.
//
// Claude Code installs a plugin as a copy named by its commit's 12-character
// prefix (`~/.claude/plugins/cache/verkstad/verkstad/<prefix>/`), which is not a
// git checkout. A CLI run from anywhere else (the verkstad checkout, one of its
// worktrees) is not a plugin copy, and is never behind.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tryGit } from "./git.ts";

const UPDATE = "`claude plugin marketplace update verkstad` and `claude plugin update verkstad@verkstad`";

/**
 * One line saying the plugin copy is behind `origin/main` of the verkstad checkout,
 * `${VERKSTAD_HOME:-$HOME/code/verkstad}`, and how to update it; or null when it is
 * not a plugin copy, the checkout is missing, or the copy is not behind.
 */
export function staleCopyWarning(): string | null {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const prefix = basename(root);
  if (!/^[0-9a-f]{12}$/.test(prefix)) return null;

  const checkout = process.env.VERKSTAD_HOME || join(homedir(), "code", "verkstad");
  if (!existsSync(checkout)) return null;
  const commit = (rev: string): string | null => {
    const r = tryGit(checkout, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const main = commit("origin/main");
  const copy = commit(prefix);
  if (!main || !copy || copy === main) return null;
  if (tryGit(checkout, ["merge-base", "--is-ancestor", copy, main]).status !== 0) return null;

  return `this plugin copy is at ${prefix}, behind verkstad's main at ${main.slice(0, 12)}; update it with ${UPDATE}, then restart Claude Code`;
}
