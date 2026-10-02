import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { project, type Project } from "./project.ts";

interface Step {
  name: string;
  command: string;
  [field: string]: unknown;
}

function contract(steps: Step[], gate: Record<string, unknown> = {}): object {
  return { baseBranch: "main", gate: { ...gate, steps }, surfaces: [] };
}

/** The Gate logs in the main checkout's log directory, oldest first. */
function logs(p: Project): string[] {
  const dir = join(p.dir, ".claude", "verkstad");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith("gate-"))
    .sort()
    .map((f) => join(dir, f));
}

/** The one Gate log, which the output must name. */
function onlyLog(p: Project, output: string): string {
  const all = logs(p);
  assert.equal(all.length, 1, `expected one Gate log, found ${all.join(", ")}`);
  assert.ok(output.includes(all[0]), `the output names the log ${all[0]}:\n${output}`);
  return readFileSync(all[0], "utf8");
}

/** A worktree of the Project on a new branch off main, as an implementing agent gets. */
function worktree(p: Project, name: string): string {
  const wt = join(p.dir, "..", name);
  p.git("worktree", "add", "--quiet", "-b", name, wt, "main");
  return wt;
}

test("with every step passing, the Gate prints each step ok and a pass line, and keeps the full log", (t) => {
  const p = project(t, {
    contract: contract([
      { name: "typecheck", command: "echo checking types" },
      { name: "unit tests", command: "echo 3 passed >&2" },
    ]),
  });

  const r = p.run("gate");

  assert.equal(r.stderr, "");
  assert.equal(r.code, 0);
  const [log] = logs(p);
  assert.match(log, /\/\.claude\/verkstad\/gate-project-\d{8}-\d{6}\.log$/);
  assert.equal(r.stdout, `ok  typecheck\nok  unit tests\nGate passed. Log: ${log}\n`);
  assert.equal(readFileSync(log, "utf8"), "== typecheck\nchecking types\n== unit tests\n3 passed\n");
});

test("a failing step stops the Gate: it prints only that step's output and the full log's path, and exits 1", (t) => {
  const noisy = Array.from({ length: 100 }, (_, i) => `echo line ${i + 1}`).join("; ");
  const p = project(t, {
    contract: contract([
      { name: "typecheck", command: "echo all fine" },
      { name: "unit tests", command: `${noisy}; echo 'expected 2, got 3' >&2; exit 3` },
      { name: "e2e", command: "touch e2e-ran" },
    ]),
  });

  const r = p.run("gate");

  assert.equal(r.code, 1);
  assert.equal(r.stdout, "ok  typecheck\n");
  const lines = r.stderr.split("\n");
  assert.equal(lines[0], "verkstad gate: unit tests failed (exit 3). The end of its output:");
  assert.deepEqual(lines.slice(1, 3), ["line 42", "line 43"]);
  assert.deepEqual(lines.slice(-4), ["line 100", "expected 2, got 3", `Full log: ${logs(p)[0]}`, ""]);
  assert.equal(lines.length, 1 + 60 + 2);
  assert.doesNotMatch(r.stderr, /all fine|line 41\n|== /);
  assert.equal(existsSync(join(p.dir, "e2e-ran")), false, "no step runs after the failing one");
  const log = onlyLog(p, r.stderr);
  assert.match(log, /^== typecheck\nall fine\n== unit tests\nline 1\n/);
  assert.match(log, /line 100\nexpected 2, got 3\n$/);
  assert.doesNotMatch(log, /== e2e/);
});

test("a step killed by a signal fails the Gate and says so", (t) => {
  const p = project(t, { contract: contract([{ name: "hangs", command: "echo started; kill -TERM $$" }]) });

  const r = p.run("gate");

  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^verkstad gate: hangs failed \(killed by SIGTERM\)\. The end of its output:\nstarted\nFull log: \//);
});

test("steps run in bash from the worktree root, with the Gate's env: $VARs expanded, null unsetting", (t) => {
  const p = project(t, {
    contract: contract(
      [
        { name: "where", command: "pwd" },
        { name: "env", command: 'echo "tools=$TOOLS lang=${LANG-unset}"; [[ -n $HOME ]]' },
      ],
      { env: { TOOLS: "${HOME}/.cargo/bin:$TOOLS_TAIL", LANG: null } },
    ),
  });
  const wt = worktree(p, "issue-7");
  mkdirSync(join(wt, "src", "deep"), { recursive: true });

  const r = p.runIn(join(wt, "src", "deep"), "gate");

  assert.equal(r.stderr, "");
  assert.equal(r.code, 0);
  const log = onlyLog(p, r.stdout);
  assert.equal(log, `== where\n${wt}\n== env\ntools=${p.env.HOME}/.cargo/bin: lang=unset\n`);
});

test("run from a worktree, the log lands in the main checkout's gitignored log directory, named for the worktree", (t) => {
  const p = project(t, { contract: contract([{ name: "build", command: "echo built" }]) });
  const wt = worktree(p, "issue-12");

  const r = p.runIn(wt, "gate");

  assert.equal(r.code, 0, r.stderr);
  const [log] = logs(p);
  assert.match(log, new RegExp(`^${p.dir}/\\.claude/verkstad/gate-issue-12-\\d{8}-\\d{6}\\.log$`));
  assert.equal(existsSync(join(wt, ".claude", "verkstad")), false);
  assert.equal(p.git("status", "--porcelain"), "");
  assert.equal(p.git("-C", wt, "status", "--porcelain"), "");
});

test("two Gate runs in the same second keep two logs", (t) => {
  const p = project(t, { contract: contract([{ name: "build", command: "echo built" }]) });

  const first = p.run("gate");
  const second = p.run("gate");

  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  const all = logs(p);
  assert.equal(all.length, 2);
  assert.ok(first.stdout.includes(all[0]) !== second.stdout.includes(all[0]), "each run names its own log");
});

test("the Gate refuses to log into a log directory git would track", (t) => {
  const p = project(t, {
    contract: contract([{ name: "build", command: "touch built" }]),
    files: { ".gitignore": "node_modules/\n" },
  });

  const r = p.run("gate");

  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.equal(
    r.stderr,
    `verkstad gate: the log directory ${p.dir}/.claude/verkstad/ is not gitignored; add .claude/verkstad/ to the Project's .gitignore\n`,
  );
  assert.equal(existsSync(join(p.dir, "built")), false);
});

test("a branch that adds the log directory to .gitignore can run the Gate before it lands", (t) => {
  const p = project(t, {
    contract: contract([{ name: "build", command: "echo built" }]),
    files: { ".gitignore": "node_modules/\n" },
  });
  const wt = worktree(p, "issue-15");
  writeFileSync(join(wt, ".gitignore"), "node_modules/\n.claude/verkstad/\n");

  const r = p.runIn(wt, "gate");

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^ok {2}build\nGate passed\. Log: .*\/project\/\.claude\/verkstad\/gate-issue-15-/);
});

test("a step with unlessExists is skipped while that path exists in the worktree", (t) => {
  const p = project(t, {
    contract: contract([
      { name: "install", command: "mkdir node_modules && echo installed", unlessExists: "node_modules" },
      { name: "build", command: "echo built" },
    ]),
    files: { ".gitignore": ".claude/verkstad/\nnode_modules/\n" },
  });

  const first = p.run("gate");
  const second = p.run("gate");

  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /^ok {2}install\nok {2}build\nGate passed\. /);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /^ok {2}build\nGate passed\. /);
  const secondLog = second.stdout.match(/Log: (.+)\n$/)?.[1] ?? "";
  assert.equal(readFileSync(secondLog, "utf8"), "== build\nbuilt\n");
});

const e2eStep: Step = {
  name: "e2e",
  command: 'echo "files: $E2E_FILES"; touch e2e-ran',
  quick: { files: "e2e/*.e2e.ts", env: "E2E_FILES" },
};

function e2eProject(t: Parameters<typeof project>[0]): Project {
  return project(t, {
    contract: contract([{ name: "unit tests", command: "echo unit ok" }, e2eStep]),
    files: {
      "e2e/a.e2e.ts": "a\n",
      "e2e/b.e2e.ts": "b\n",
      "e2e/gone.e2e.ts": "gone\n",
      "e2e/helper.ts": "helper\n",
    },
  });
}

test("--quick narrows the step to the e2e files the branch added or changed since it left the base branch, untracked ones included", (t) => {
  const p = e2eProject(t);
  const wt = worktree(p, "issue-9");
  writeFileSync(join(wt, "e2e", "a.e2e.ts"), "a changed\n");
  writeFileSync(join(wt, "e2e", "c.e2e.ts"), "c\n");
  writeFileSync(join(wt, "e2e", "helper.ts"), "helper changed\n");
  rmSync(join(wt, "e2e", "gone.e2e.ts"));
  p.git("-C", wt, "add", "-A");
  p.git("-C", wt, "commit", "--quiet", "-m", "Change e2e tests");
  writeFileSync(join(wt, "e2e", "d.e2e.ts"), "d, not committed yet\n");
  writeFileSync(join(wt, "e2e", "notes.txt"), "not a test\n");
  // main moves on after the branch left it; b changed there is not the branch's change.
  writeFileSync(join(p.dir, "e2e", "b.e2e.ts"), "b changed on main\n");
  p.git("commit", "--quiet", "-am", "Change b on main");
  p.git("push", "--quiet", "origin", "main");

  const r = p.runIn(wt, "gate", "--quick");

  assert.equal(r.stderr, "");
  assert.equal(r.code, 0);
  const log = onlyLog(p, r.stdout);
  assert.equal(r.stdout, `ok  unit tests\nok  e2e (3 changed files)\nQuick gate passed. Log: ${logs(p)[0]}\n`);
  assert.equal(log, "== unit tests\nunit ok\n== e2e (3 changed files)\nfiles: e2e/a.e2e.ts e2e/c.e2e.ts e2e/d.e2e.ts\n");
});

test("--quick with no e2e file changed skips the step with a line saying so; other steps still run", (t) => {
  const p = e2eProject(t);
  const wt = worktree(p, "issue-10");
  writeFileSync(join(wt, "e2e", "helper.ts"), "helper changed\n");

  const r = p.runIn(wt, "gate", "--quick");

  assert.equal(r.code, 0, r.stderr);
  assert.equal(
    r.stdout,
    `ok  unit tests\n--  e2e skipped: no file matching e2e/*.e2e.ts changed since main\nQuick gate passed. Log: ${logs(p)[0]}\n`,
  );
  assert.equal(existsSync(join(wt, "e2e-ran")), false);
});

test("without --quick the narrowed step runs whole, with its variable unset even when the caller set it", (t) => {
  const p = e2eProject(t);
  const wt = worktree(p, "issue-11");
  writeFileSync(join(wt, "e2e", "c.e2e.ts"), "c\n");
  p.env.E2E_FILES = "e2e/stale.e2e.ts";

  const r = p.runIn(wt, "gate");

  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `ok  unit tests\nok  e2e\nGate passed. Log: ${logs(p)[0]}\n`);
  assert.match(readFileSync(logs(p)[0], "utf8"), /== e2e\nfiles: \n$/);
});

test("--quick runs a step in full when a changed file matches its fullWhen globs, deleted ones included", (t) => {
  const p = project(t, {
    contract: contract([{ ...e2eStep, quick: { ...(e2eStep.quick as object), fullWhen: ["e2e/*.ts", "fake/**"] } }]),
    files: { "e2e/a.e2e.ts": "a\n", "e2e/app.ts": "harness\n", "fake/src/main.rs": "fn main() {}\n" },
  });
  const wt = worktree(p, "issue-13");
  rmSync(join(wt, "e2e", "app.ts"));
  writeFileSync(join(wt, "fake", "src", "main.rs"), "fn main() { loop {} }\n");

  const r = p.runIn(wt, "gate", "--quick");

  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `ok  e2e (in full: e2e/app.ts and 1 more changed)\nQuick gate passed. Log: ${logs(p)[0]}\n`);
  assert.equal(readFileSync(logs(p)[0], "utf8"), "== e2e (in full: e2e/app.ts and 1 more changed)\nfiles: \n");
});

test("--quick narrows as usual when no changed file matches fullWhen", (t) => {
  const p = project(t, {
    contract: contract([{ ...e2eStep, quick: { ...(e2eStep.quick as object), fullWhen: ["fake/**"] } }]),
    files: { "e2e/a.e2e.ts": "a\n", "fake/src/main.rs": "fn main() {}\n" },
  });
  const wt = worktree(p, "issue-14");
  writeFileSync(join(wt, "e2e", "a.e2e.ts"), "a changed\n");

  const r = p.runIn(wt, "gate", "--quick");

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^ok {2}e2e \(1 changed file\)\n/);
  assert.match(readFileSync(logs(p)[0], "utf8"), /files: e2e\/a\.e2e\.ts\n$/);
});

test("--quick fails before any step runs when the base branch has no origin ref to diff against", (t) => {
  const p = project(t, {
    contract: { ...contract([{ name: "unit tests", command: "echo unit ok" }, e2eStep]), baseBranch: "trunk" },
  });

  const r = p.run("gate", "--quick");

  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^verkstad gate: --quick needs origin\/trunk to find what the branch changed: /);
});

test("an unknown option is a usage error", (t) => {
  const p = project(t, { contract: contract([{ name: "build", command: "touch built" }]) });

  const r = p.run("gate", "--fast");

  assert.equal(r.code, 2);
  assert.equal(r.stderr, "verkstad gate: unknown option '--fast'; usage: verkstad gate [--quick]\n");
  assert.equal(existsSync(join(p.dir, "built")), false);
});

test("a missing Contract fails with a message naming the file", (t) => {
  const p = project(t, { contract: null });

  const r = p.run("gate");

  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, `verkstad gate: no Contract: ${p.dir}/.claude/harness.json does not exist\n`);
});

test("a Contract that is not JSON fails with the parser's complaint", (t) => {
  const p = project(t, { contract: null, files: { ".claude/harness.json": '{ "baseBranch": "main", }\n' } });

  const r = p.run("gate");

  assert.equal(r.code, 1);
  assert.match(r.stderr, /^verkstad gate: \.claude\/harness\.json is not valid JSON: .+\n$/);
});

const malformed: Array<[string, unknown, string]> = [
  ["a Contract that is not an object", [], "the Contract must be a JSON object"],
  ["no baseBranch", { gate: { steps: [{ name: "a", command: "true" }] } }, "baseBranch must be a non-empty string"],
  ["no gate", { baseBranch: "main" }, "gate must be an object"],
  ["no steps", { baseBranch: "main", gate: { steps: [] } }, "gate.steps must be a non-empty array"],
  [
    "a step without a command",
    { baseBranch: "main", gate: { steps: [{ name: "a", command: "true" }, { name: "b" }] } },
    "gate.steps[1].command must be a non-empty string",
  ],
  [
    "a misspelt step field",
    { baseBranch: "main", gate: { steps: [{ name: "a", comand: "true" }] } },
    "gate.steps[0] has an unknown field 'comand' (known: name, command, unlessExists, quick)",
  ],
  [
    "a fullWhen that is one string",
    {
      baseBranch: "main",
      gate: { steps: [{ name: "e2e", command: "true", quick: { files: "e2e/*.ts", env: "F", fullWhen: "e2e/app.ts" } }] },
    },
    "gate.steps[0].quick.fullWhen must be an array of path globs",
  ],
  [
    "two steps with one name",
    { baseBranch: "main", gate: { steps: [{ name: "a", command: "true" }, { name: "a", command: "false" }] } },
    "gate.steps[1].name 'a' is already the name of gate.steps[0]",
  ],
  [
    "a quick without its env",
    { baseBranch: "main", gate: { steps: [{ name: "e2e", command: "true", quick: { files: "e2e/*.ts" } }] } },
    "gate.steps[0].quick.env must be an environment variable name",
  ],
  [
    "an env value that is a number",
    { baseBranch: "main", gate: { env: { JOBS: 4 }, steps: [{ name: "a", command: "true" }] } },
    "gate.env.JOBS must be a string or null",
  ],
];

for (const [scenario, value, problem] of malformed) {
  test(`a malformed Contract fails before any step runs: ${scenario}`, (t) => {
    const p = project(t, { contract: value as object });

    const r = p.run("gate");

    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, `verkstad gate: .claude/harness.json: ${problem}\n`);
    assert.deepEqual(logs(p), []);
  });
}
