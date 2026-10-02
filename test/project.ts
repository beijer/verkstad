// The throwaway Project every test runs the CLI against: a temp dir holding a
// git repo with a Contract, whose `origin` is a local bare repo, and a stub `gh`
// (test/stub/gh.ts) first on the PATH. Nothing reaches GitHub.
//
//   const p = project(t, { issues: [{ number: 2, labels: ["ready-for-agent"] }] });
//   const r = p.run("frontier", "--json");
//   assert.equal(r.code, 0);
//   p.calls();  // every gh argv the CLI ran
//   p.state();  // the stub's GitHub after the run

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { StubFailure, StubIssue, StubLabel, StubPullRequest, StubState } from "./stub/state.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const verkstad = join(root, "bin", "verkstad");
const stubBin = join(root, "test", "stub");

/** What a test seeds; anything left out gets a default. */
export interface Seed {
  repo?: string;
  issues?: Array<Partial<StubIssue> & { number: number }>;
  pullRequests?: StubPullRequest[];
  labels?: StubLabel[];
  pageSize?: number;
  failures?: StubFailure[];
  /** The Project's `.claude/harness.json`, or null for a Project without one. */
  contract?: object | null;
  /** More files to commit in the Project, path → content. */
  files?: Record<string, string>;
}

export interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Project {
  /** The Project's main checkout. */
  dir: string;
  /** The bare repo that is the checkout's `origin`. */
  origin: string;
  /** The environment the CLI runs in: the stub `gh` first on PATH, an isolated HOME and git config. */
  env: NodeJS.ProcessEnv;
  /** Runs `bin/verkstad` in the main checkout. */
  run(...args: string[]): Result;
  /** Runs `bin/verkstad` in another directory (a worktree, say). */
  runIn(cwd: string, ...args: string[]): Result;
  /** Starts `bin/verkstad` in `cwd` without waiting for it, so that several can run at once. */
  start(cwd: string, ...args: string[]): Promise<Result>;
  /** Runs git in the main checkout (or `-C` elsewhere) and returns its trimmed stdout. */
  git(...args: string[]): string;
  /** The stub's GitHub now. */
  state(): StubState;
  /** Every `gh` call so far, as argv arrays. */
  calls(): string[][];
}

export const defaultContract = {
  baseBranch: "main",
  surfaces: [],
};

export function issue(seed: Partial<StubIssue> & { number: number }): StubIssue {
  return {
    id: 1_000_000 + seed.number,
    title: `Issue ${seed.number}`,
    body: "",
    state: "open",
    labels: [],
    assignees: [],
    comments: [],
    parent: null,
    blockedBy: [],
    ...seed,
  };
}

export function project(t: TestContext, seed: Seed = {}): Project {
  const tmp = mkdtempSync(join(tmpdir(), "verkstad-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const stubDir = join(tmp, "gh");
  const home = join(tmp, "home");
  const dir = join(tmp, "project");
  const origin = join(tmp, "origin.git");
  mkdirSync(stubDir);
  mkdirSync(home);

  const state: StubState = {
    repo: seed.repo ?? "owner/project",
    viewer: "owner",
    issues: (seed.issues ?? []).map(issue),
    pullRequests: seed.pullRequests ?? [],
    labels: seed.labels ?? [],
    ...(seed.pageSize ? { pageSize: seed.pageSize } : {}),
    ...(seed.failures ? { failures: seed.failures } : {}),
  };
  writeFileSync(join(stubDir, "state.json"), JSON.stringify(state, null, 2) + "\n");
  writeFileSync(join(stubDir, "calls.jsonl"), "");
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n");

  const env: NodeJS.ProcessEnv = {
    PATH: `${stubBin}:${process.env.PATH}`,
    HOME: home,
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    VERKSTAD_GH_STUB_DIR: stubDir,
    TMPDIR: tmp,
    LANG: "C",
  };

  const git = (...args: string[]): string => {
    const r = spawnSync("git", args, { cwd: existsSync(dir) ? dir : tmp, env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout.trim();
  };

  const files: Record<string, string> = {
    ".gitignore": ".claude/verkstad/\n",
    "docs/agents/project.md": "# Project\n",
    ...seed.files,
  };
  const contract = seed.contract === undefined ? defaultContract : seed.contract;
  if (contract !== null) files[".claude/harness.json"] = JSON.stringify(contract, null, 2) + "\n";

  git("init", "--quiet", "--bare", "-b", "main", origin);
  mkdirSync(dir);
  git("init", "--quiet", "-b", "main");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git("add", "-A");
  git("commit", "--quiet", "-m", "A throwaway Project");
  git("remote", "add", "origin", origin);
  git("push", "--quiet", "-u", "origin", "main");

  const runIn = (cwd: string, ...args: string[]): Result => {
    const r = spawnSync(verkstad, args, { cwd, env, encoding: "utf8" });
    return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
  };

  const start = (cwd: string, ...args: string[]): Promise<Result> =>
    new Promise((done, failed) => {
      const child = spawn(verkstad, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.on("error", failed);
      child.on("close", (code) => done({ code: code ?? -1, stdout, stderr }));
    });

  return {
    dir,
    origin,
    env,
    run: (...args) => runIn(dir, ...args),
    runIn,
    start,
    git,
    state: () => JSON.parse(readFileSync(join(stubDir, "state.json"), "utf8")) as StubState,
    calls: () =>
      readFileSync(join(stubDir, "calls.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
  };
}
