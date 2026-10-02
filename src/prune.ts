// `verkstad prune`: deletes what the log directory holds (Gate logs, Verify logs,
// reports, Verdicts, Evidence) once it is older than 30 days. Landing runs it too.

import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Failure } from "./fail.ts";
import { logDirectory } from "./git.ts";

const MAX_AGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** When anything in `path` last changed: a directory is as new as the newest entry in it. */
function lastModified(path: string): number {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return readdirSync(path).reduce((newest, entry) => Math.max(newest, lastModified(join(path, entry))), stat.mtimeMs);
}

/** Deletes the entries of the log directory `dir` older than 30 days and returns their names, sorted. */
export function pruneLogDirectory(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const cutoff = Date.now() - MAX_AGE_DAYS * DAY_MS;
  const old = readdirSync(dir)
    .filter((entry) => lastModified(join(dir, entry)) < cutoff)
    .sort();
  for (const entry of old) rmSync(join(dir, entry), { recursive: true, force: true });
  return old;
}

/** The lines saying what a prune deleted; none when it deleted nothing. */
export function describePruned(dir: string, deleted: string[]): string {
  if (deleted.length === 0) return "";
  const entries = deleted.length === 1 ? "1 entry" : `${deleted.length} entries`;
  return `Pruned ${entries} older than ${MAX_AGE_DAYS} days from ${dir}:\n${deleted.map((e) => `  ${e}\n`).join("")}`;
}

export function prune(args: string[]): void {
  if (args.length) throw new Failure(`unknown argument '${args[0]}'; usage: verkstad prune`, 2);
  const dir = logDirectory(process.cwd());
  const deleted = pruneLogDirectory(dir);
  process.stdout.write(describePruned(dir, deleted) || `Nothing older than ${MAX_AGE_DAYS} days in ${dir}.\n`);
}
