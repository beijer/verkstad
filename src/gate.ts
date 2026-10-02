// `verkstad gate [--quick]`: runs the Contract's Gate steps in order from the
// worktree root, stopping at the first failure. It prints `ok  <step>` per step
// and a pass line, or the failing step's last lines; the full log goes to the
// log directory in the main checkout.

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { basename, join } from "node:path";
import { type Contract, type GateStep, readContract, VARIABLE } from "./contract.ts";
import { Failure } from "./fail.ts";
import { logDirectory, mainCheckout, tryGit, worktreeRoot } from "./git.ts";

const USAGE = "usage: verkstad gate [--quick]";
/** How many of a failing step's last lines the Gate prints. */
const TAIL_LINES = 60;

/** A step as this run runs it: under --quick, a narrowed step knows its changed files. */
interface PlannedStep {
  step: GateStep;
  label: string;
  env: Record<string, string>;
  /** Why the step does not run this time, if it doesn't. */
  skip?: string;
}

function parseArgs(args: string[]): { quick: boolean } {
  let quick = false;
  for (const arg of args) {
    if (arg === "--quick") quick = true;
    else throw new Failure(`unknown option '${arg}'; ${USAGE}`, 2);
  }
  return { quick };
}

/** Expands `$NAME` and `${NAME}` from the environment the Gate was started in; an unset name is empty. */
function expand(value: string): string {
  const reference = new RegExp(`\\$\\{(${VARIABLE})\\}|\\$(${VARIABLE})`, "g");
  return value.replace(reference, (_, braced, bare) => process.env[braced ?? bare] ?? "");
}

function stepEnvironment(contract: Contract): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [name, value] of Object.entries(contract.gate.env)) {
    if (value === null) delete env[name];
    else env[name] = expand(value);
  }
  return env;
}

/**
 * The files matching the pathspecs that the branch changed since it left the base branch, untracked ones
 * included: added or modified ones only, or deleted ones too.
 */
function changedFiles(root: string, since: string, pathspecs: string[], deleted: boolean): string[] {
  const filter = deleted ? [] : ["--diff-filter=d"];
  const diff = tryGit(root, ["diff", "-z", "--name-only", ...filter, since, "--", ...pathspecs]);
  const untracked = tryGit(root, ["ls-files", "-z", "--others", "--exclude-standard", "--", ...pathspecs]);
  for (const r of [diff, untracked]) {
    if (r.status !== 0) throw new Failure(`--quick could not list the changed files: ${r.stderr.trim()}`);
  }
  const files = [...diff.stdout.split("\0"), ...untracked.stdout.split("\0")].filter(Boolean);
  return [...new Set(files)];
}

function plan(root: string, contract: Contract, quick: boolean): PlannedStep[] {
  const narrowed = quick && contract.gate.steps.some((s) => s.quick);
  let since = "";
  if (narrowed) {
    const base = `origin/${contract.baseBranch}`;
    const r = tryGit(root, ["merge-base", "HEAD", base]);
    if (r.status !== 0) {
      throw new Failure(`--quick needs ${base} to find what the branch changed: ${r.stderr.trim() || "no common ancestor with HEAD"}`);
    }
    since = r.stdout.trim();
  }
  return contract.gate.steps.map((step): PlannedStep => {
    if (!quick || !step.quick) return { step, label: step.name, env: {} };
    const fullRunCauses = step.quick.fullWhen.length ? changedFiles(root, since, step.quick.fullWhen, true) : [];
    if (fullRunCauses.length) {
      const more = fullRunCauses.length > 1 ? ` and ${fullRunCauses.length - 1} more` : "";
      return { step, label: `${step.name} (in full: ${fullRunCauses[0]}${more} changed)`, env: {} };
    }
    const files = changedFiles(root, since, [step.quick.files], false);
    if (files.length === 0) {
      return {
        step,
        label: step.name,
        env: {},
        skip: `no file matching ${step.quick.files} changed since ${contract.baseBranch}`,
      };
    }
    const count = `${files.length} changed file${files.length === 1 ? "" : "s"}`;
    return { step, label: `${step.name} (${count})`, env: { [step.quick.env]: files.join(" ") } };
  });
}

/**
 * Fails unless git ignores the log directory, so that no log is ever committed: in the main checkout, or
 * in the worktree whose branch adds it to .gitignore and has not landed yet.
 */
function checkIgnored(root: string, dir: string): void {
  const ignored = (cwd: string) => tryGit(cwd, ["check-ignore", "-q", ".claude/verkstad/"]).status === 0;
  if (!ignored(root) && !ignored(mainCheckout(root))) {
    throw new Failure(`the log directory ${dir}/ is not gitignored; add .claude/verkstad/ to the Project's .gitignore`);
  }
  mkdirSync(dir, { recursive: true });
}

function timestamp(now: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`;
  return `${date}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
}

/** Creates this run's log, `gate-<worktree>-<time>.log`, never reusing another run's. */
function createLog(dir: string, root: string): { path: string; fd: number } {
  const stem = join(dir, `gate-${basename(root)}-${timestamp(new Date())}`);
  for (let n = 1; ; n++) {
    const path = n === 1 ? `${stem}.log` : `${stem}-${n}.log`;
    try {
      return { path, fd: openSync(path, "ax") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

function lastLines(text: string, count: number): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-count);
}

export function gate(args: string[]): void {
  const { quick } = parseArgs(args);
  runGate(worktreeRoot(process.cwd()), quick);
}

/**
 * Runs the Gate in the worktree at `root`, printing a line per step and the pass line, and returns the
 * full log's path. A failing step throws a Failure naming the step, with its last lines and the log's path.
 */
export function runGate(root: string, quick: boolean): string {
  const contract = readContract(root);
  const planned = plan(root, contract, quick);
  const dir = logDirectory(root);
  checkIgnored(root, dir);
  const env = stepEnvironment(contract);
  const log = createLog(dir, root);

  try {
    for (const p of planned) {
      if (p.skip) {
        process.stdout.write(`--  ${p.label} skipped: ${p.skip}\n`);
        continue;
      }
      // Checked as the step comes up, since an earlier step may create the path.
      if (p.step.unlessExists && existsSync(join(root, p.step.unlessExists))) continue;
      writeSync(log.fd, `== ${p.label}\n`);
      const start = fstatSync(log.fd).size;
      const stepEnv = { ...env, ...p.env };
      // A step that runs in full never sees a narrowing left in the environment.
      if (p.step.quick && !(p.step.quick.env in p.env)) delete stepEnv[p.step.quick.env];
      const r = spawnSync("bash", ["-c", p.step.command], {
        cwd: root,
        env: stepEnv,
        stdio: ["ignore", log.fd, log.fd],
      });
      if (r.error) throw new Failure(`could not run bash for ${p.label}: ${r.error.message}`);
      if (r.status === 0) {
        process.stdout.write(`ok  ${p.label}\n`);
        continue;
      }
      const how = r.signal ? `killed by ${r.signal}` : `exit ${r.status}`;
      const tail = lastLines(readFileSync(log.path).subarray(start).toString("utf8"), TAIL_LINES);
      const output = tail.length ? ` The end of its output:\n${tail.join("\n")}` : " It printed nothing.";
      throw new Failure(`${p.label} failed (${how}).${output}\nFull log: ${log.path}`);
    }
  } finally {
    closeSync(log.fd);
  }
  process.stdout.write(`${quick ? "Quick gate passed" : "Gate passed"}. Log: ${log.path}\n`);
  return log.path;
}
