// `verkstad frontier` warns on stderr when the plugin copy it runs from is behind
// main of the verkstad checkout, `${VERKSTAD_HOME:-$HOME/code/verkstad}`. Each test
// builds its own fake copy (a directory named by a commit prefix, as Claude Code's
// plugin cache names them) and its own fake checkout, never the real ones.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type Project, project, type Result } from "./project.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const READY = "ready-for-agent";
const listing = ["Ready (1):", "  #2 Plugin skeleton", "In progress (0):", "Waiting (0):", ""].join("\n");

/** Copies the CLI (bin/, src/, package.json) into `dir`. */
function copyCli(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const part of ["bin", "src", "package.json"]) cpSync(join(root, part), join(dir, part), { recursive: true });
}

interface Checkout {
  dir: string;
  /** The older commit, and the one origin/main is at. */
  old: string;
  main: string;
}

/** A verkstad checkout at `dir` (beside the Project by default), holding the CLI, whose origin/main is one commit past `old`. */
function verkstadCheckout(p: Project, dir = join(dirname(p.dir), "verkstad")): Checkout {
  const origin = join(dirname(p.dir), "verkstad-origin.git");
  const git = (...args: string[]) => p.git("-C", dir, ...args);
  p.git("init", "--quiet", "--bare", "-b", "main", origin);
  p.git("init", "--quiet", "-b", "main", dir);
  copyCli(dir);
  git("add", "-A");
  git("commit", "--quiet", "-m", "The old verkstad");
  git("remote", "add", "origin", origin);
  git("push", "--quiet", "-u", "origin", "main");
  const old = git("rev-parse", "HEAD");
  writeFileSync(join(dir, "NEWS"), "Agents learn which shell forms their worktree refuses\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "The new verkstad");
  git("push", "--quiet", "origin", "main");
  return { dir, old, main: git("rev-parse", "HEAD") };
}

/** A plugin copy in a fake plugin cache, named by `commit`'s 12-character prefix, as Claude Code names its copies. */
function pluginCopy(p: Project, commit: string): string {
  const dir = join(dirname(p.dir), "home", ".claude", "plugins", "cache", "verkstad", "verkstad", commit.slice(0, 12));
  copyCli(dir);
  return dir;
}

/** Runs the `verkstad` in `copy` in the Project, with VERKSTAD_HOME set to `home` unless it is undefined. */
function runFrom(p: Project, copy: string, home: string | undefined, ...args: string[]): Result {
  const env = { ...p.env, ...(home === undefined ? {} : { VERKSTAD_HOME: home }) };
  const r = spawnSync(join(copy, "bin", "verkstad"), args, { cwd: p.dir, env, encoding: "utf8" });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

function ticketProject(t: Parameters<typeof project>[0]): Project {
  return project(t, { issues: [{ number: 2, title: "Plugin skeleton", labels: [READY] }] });
}

function warning(checkout: Checkout): string {
  return (
    `verkstad frontier: this plugin copy is at ${checkout.old.slice(0, 12)}, behind verkstad's main at ${checkout.main.slice(0, 12)}; ` +
    "update it with `claude plugin marketplace update verkstad` and `claude plugin update verkstad@verkstad`, then restart Claude Code\n"
  );
}

test("a plugin copy behind the checkout's main makes frontier warn on stderr with both commits and the update commands, and still list the Frontier", (t) => {
  const p = ticketProject(t);
  const checkout = verkstadCheckout(p);
  const copy = pluginCopy(p, checkout.old);

  const r = runFrom(p, copy, checkout.dir, "frontier");

  assert.deepEqual(r, { code: 0, stdout: listing, stderr: warning(checkout) });
});

test("without VERKSTAD_HOME, the checkout is $HOME/code/verkstad", (t) => {
  const p = ticketProject(t);
  const checkout = verkstadCheckout(p, join(p.env.HOME!, "code", "verkstad"));
  const copy = pluginCopy(p, checkout.old);

  const r = runFrom(p, copy, undefined, "frontier");

  assert.deepEqual(r, { code: 0, stdout: listing, stderr: warning(checkout) });
});

test("--json prints the same data with a stale copy, and the warning only on stderr", (t) => {
  const p = ticketProject(t);
  const checkout = verkstadCheckout(p);
  const copy = pluginCopy(p, checkout.old);

  const r = runFrom(p, copy, checkout.dir, "frontier", "--json");

  assert.equal(r.code, 0);
  assert.equal(r.stderr, warning(checkout));
  assert.deepEqual(JSON.parse(r.stdout), {
    ready: [{ number: 2, title: "Plugin skeleton", labels: [READY], assignees: [], open_blockers: [] }],
    in_progress: [],
    waiting: [],
    specs_labelled: [],
  });
});

test("a plugin copy at the checkout's main prints nothing extra", (t) => {
  const p = ticketProject(t);
  const checkout = verkstadCheckout(p);
  const copy = pluginCopy(p, checkout.main);

  const r = runFrom(p, copy, checkout.dir, "frontier");

  assert.deepEqual(r, { code: 0, stdout: listing, stderr: "" });
});

test("a plugin copy at a commit the checkout has not fetched prints nothing extra", (t) => {
  const p = ticketProject(t);
  const checkout = verkstadCheckout(p);
  const copy = pluginCopy(p, "0123456789ab");

  const r = runFrom(p, copy, checkout.dir, "frontier");

  assert.deepEqual(r, { code: 0, stdout: listing, stderr: "" });
});

test("run from the checkout itself, even one whose HEAD is behind its main, frontier prints nothing extra", (t) => {
  const p = ticketProject(t);
  const checkout = verkstadCheckout(p);
  p.git("-C", checkout.dir, "reset", "--quiet", "--hard", checkout.old);

  const r = runFrom(p, checkout.dir, checkout.dir, "frontier");

  assert.deepEqual(r, { code: 0, stdout: listing, stderr: "" });
});

test("with no checkout, at VERKSTAD_HOME or at $HOME/code/verkstad, a plugin copy prints nothing extra", (t) => {
  const p = ticketProject(t);
  const copy = pluginCopy(p, "0123456789ab");

  const unset = runFrom(p, copy, undefined, "frontier");
  const missing = runFrom(p, copy, join(dirname(p.dir), "no-such-checkout"), "frontier");

  assert.deepEqual(unset, { code: 0, stdout: listing, stderr: "" });
  assert.deepEqual(missing, { code: 0, stdout: listing, stderr: "" });
});
