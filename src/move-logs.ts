// Moves what an implementing agent left under its worktree's gitignored .claude/verkstad/ (its notes, its
// Walk evidence) into the log directory, before Landing or Parking removes the worktree. The agent cannot
// write to the log directory itself: its session is isolated to its worktree.

import { cpSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { extname, join } from "node:path";

/** An entry moved into the log directory: its path there, relative, and the name it was renamed to, if any. */
interface Moved {
  path: string;
  renamed: string | null;
}

function present(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

function isDirectory(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

/** The first of `notes-2.md`, `notes-3.md`, … not taken in `dir`, for `notes.md`. */
function freeName(dir: string, name: string): string {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!present(join(dir, candidate))) return candidate;
  }
}

/** Renames `from` to `to`, copying and deleting when they are on different filesystems. */
function move(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    rmSync(from, { recursive: true, force: true });
  }
}

/** Moves the entries of `from` into `to`, merging directories both have and renaming a taken name beside it. */
function moveInto(from: string, to: string, prefix: string, moved: Moved[]): void {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from).sort()) {
    const source = join(from, name);
    const target = join(to, name);
    if (isDirectory(source) && isDirectory(target)) {
      moveInto(source, target, `${prefix}${name}/`, moved);
    } else if (!present(target)) {
      move(source, target);
      moved.push({ path: `${prefix}${name}`, renamed: null });
    } else {
      const free = freeName(to, name);
      move(source, join(to, free));
      moved.push({ path: `${prefix}${name}`, renamed: free });
    }
  }
}

/**
 * Moves what is under `<root>/.claude/verkstad/` into the log directory `logDir`, keeping what is there
 * already, and returns the lines saying what it moved; none when there was nothing. Throws when a move fails.
 */
export function moveWorktreeLogs(root: string, logDir: string): string {
  const from = join(root, ".claude", "verkstad");
  if (!isDirectory(from)) return "";
  const moved: Moved[] = [];
  moveInto(from, logDir, "", moved);
  if (moved.length === 0) return "";
  const entries = moved.length === 1 ? "1 entry" : `${moved.length} entries`;
  const lines = moved.map(({ path, renamed }) => `  ${path}${renamed === null ? "" : `, as ${renamed}`}\n`);
  return `Moved ${entries} from the worktree's .claude/verkstad/ into ${logDir}:\n${lines.join("")}`;
}
