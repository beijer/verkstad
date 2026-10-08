// `verkstad surfaces <base> [--json]`: the Surfaces the branch checked out here
// touches: those with a glob matching a path the branch's commits changed since
// it left <base> (`git diff <base>...HEAD`), deleted paths and both sides of a
// rename included (ADR 0004), and no `!` glob of the Surface's matching it.
// Uncommitted and untracked files are not part of the branch, so they never count.
// A Surface the branch adds to the Contract is touched too, through the Contract:
// it is new, and its Verdict is what proves the Verify skill can drive it.

import { committedChecking, CONTRACT_PATH, readSurfaces, type Surface } from "./contract.ts";
import { Failure } from "./fail.ts";
import { tryGit, worktreeRoot } from "./git.ts";

const USAGE = "usage: verkstad surfaces <base> [--json]";

/** A Surface the branch touches, with the changed paths its globs match. */
export interface TouchedSurface {
  name: string;
  files: string[];
}

/** The commit where HEAD left `base`, which the branch's changes are counted from. */
export function branchPoint(root: string, base: string): string {
  const r = tryGit(root, ["merge-base", base, "HEAD"]);
  if (r.status !== 0) {
    throw new Failure(`cannot tell where HEAD left ${base}: ${r.stderr.trim() || "they have no common ancestor"}`);
  }
  return r.stdout.trim();
}

/**
 * The Surfaces, in the Contract's order, whose globs match a path committed since `since`, and those the
 * Contract committed at `since` lacks. A `since` with no Contract, or a malformed one, adds none.
 */
export function touchedSurfaces(root: string, surfaces: Surface[], since: string): TouchedSurface[] {
  const before = committedChecking(root, since)?.surfaces;
  const touched: TouchedSurface[] = [];
  for (const surface of surfaces) {
    if (before && !before.some((s) => s.name === surface.name)) {
      touched.push({ name: surface.name, files: [CONTRACT_PATH] });
      continue;
    }
    const pathspecs = surface.globs.map((glob) => (glob.startsWith("!") ? `:(exclude,glob)${glob.slice(1)}` : `:(glob)${glob}`));
    const r = tryGit(root, ["diff", "-z", "--name-only", "--no-renames", "--no-relative", since, "HEAD", "--", ...pathspecs]);
    if (r.status !== 0) throw new Failure(`could not match the Surface ${surface.name}'s globs: ${r.stderr.trim()}`);
    const files = r.stdout.split("\0").filter(Boolean);
    if (files.length) touched.push({ name: surface.name, files });
  }
  return touched;
}

/** "the Surface ui" or "the Surfaces ui, api". */
export function describeSurfaces(touched: TouchedSurface[]): string {
  const names = touched.map((s) => s.name).join(", ");
  return touched.length === 1 ? `the Surface ${names}` : `the Surfaces ${names}`;
}

export function surfaces(args: string[]): void {
  const json = args.includes("--json");
  const rest = args.filter((a) => a !== "--json");
  const unknown = rest.find((a) => a.startsWith("-"));
  if (unknown !== undefined) throw new Failure(`unknown option '${unknown}'; ${USAGE}`, 2);
  if (rest.length !== 1) throw new Failure(USAGE, 2);
  const root = worktreeRoot(process.cwd());
  const touched = touchedSurfaces(root, readSurfaces(root), branchPoint(root, rest[0]));
  if (json) process.stdout.write(JSON.stringify(touched, null, 2) + "\n");
  else process.stdout.write(touched.map((s) => `${s.name}\n`).join(""));
}
