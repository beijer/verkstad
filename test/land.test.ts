import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { project, type Project } from "./project.ts";
import type { StubIssue } from "./stub/state.ts";

const REPORT = "status: done\nWhat was built: the feature.\n";
const DAY = 24 * 60 * 60 * 1000;

interface Step {
  name: string;
  command: string;
}

/** A Contract whose Gate has these steps. Steps run from the worktree root, which sits beside the
 * main checkout (`../project`) and the bare origin (`../origin.git`) in the test's temp dir. */
function contract(steps: Step[], fields: Record<string, unknown> = {}): object {
  return { baseBranch: "main", gate: { steps }, surfaces: [], ...fields };
}

/** An open Ticket the orchestrator has claimed. */
function claimed(number: number): Partial<StubIssue> & { number: number } {
  return { number, labels: ["ready-for-agent"], assignees: ["owner"] };
}

/** A file in the test's temp dir, beside the main checkout. */
function tmpFile(p: Project, name: string, content: string): string {
  const path = join(p.dir, "..", name);
  writeFileSync(path, content);
  return path;
}

/** A Ticket's worktree as an implementing agent leaves it: branch issue-<n> off main, a commit per file set. */
function ticket(p: Project, n: number, ...commits: Array<Record<string, string>>): string {
  const wt = join(p.dir, "..", `wt-${n}`);
  p.git("worktree", "add", "--quiet", "-b", `issue-${n}`, wt, "main");
  for (const files of commits) {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(wt, path)), { recursive: true });
      writeFileSync(join(wt, path), content);
      p.git("-C", wt, "add", path);
    }
    p.git("-C", wt, "commit", "--quiet", "-m", `Adds ${Object.keys(files).join(", ")}. Refs #${n}`);
  }
  return wt;
}

/** Pushes a commit to origin's main from another clone, as another Landing would. */
function landElsewhere(p: Project, path: string, content: string, message: string): void {
  const clone = join(p.dir, "..", "elsewhere");
  if (!existsSync(clone)) p.git("clone", "--quiet", p.origin, clone);
  p.git("-C", clone, "pull", "--quiet", "--ff-only");
  writeFileSync(join(clone, path), content);
  p.git("-C", clone, "add", path);
  p.git("-C", clone, "commit", "--quiet", "-m", message);
  p.git("-C", clone, "push", "--quiet", "origin", "main");
}

/** origin's base branch, newest commit first, by subject. */
function originLog(p: Project): string[] {
  return p.git("--git-dir", p.origin, "log", "--format=%s", "main").split("\n");
}

function originHead(p: Project, ref = "main"): string {
  return p.git("--git-dir", p.origin, "rev-parse", ref);
}

function originHas(p: Project, ref: string): boolean {
  return p.git("--git-dir", p.origin, "for-each-ref", `refs/heads/${ref}`) !== "";
}

function localBranches(p: Project): string[] {
  return p.git("branch", "--list", "issue-*", "--format=%(refname:short)").split("\n").filter(Boolean);
}

function issueOf(p: Project, n: number): StubIssue {
  const issue = p.state().issues.find((i) => i.number === n);
  assert.ok(issue, `#${n} is in the stub's state`);
  return issue;
}

/** The last line of a failed Landing's stderr: the reason the orchestrator routes on. */
function reason(stderr: string): string {
  return stderr.trimEnd().split("\n").at(-1) ?? "";
}

/** Asserts a failed Landing touched nothing but its worktree: base unchanged, branch kept, no gh call. */
function assertNothingLanded(p: Project, wt: string, base: string, branchHead: string): void {
  assert.equal(originHead(p), base, "origin's main is unchanged");
  assert.equal(existsSync(wt), false, "the worktree is removed");
  assert.deepEqual(localBranches(p), ["issue-7"], "the branch is kept");
  assert.equal(p.git("rev-parse", "issue-7"), branchHead);
  assert.deepEqual(p.calls(), [], "no issue was touched");
  assert.equal(issueOf(p, 7).state, "open");
}

test("a clean branch lands: rebased onto the latest base, gated in full, pushed, the Ticket closed with the report, worktree and branch gone", (t) => {
  const p = project(t, {
    issues: [claimed(7)],
    contract: contract([
      { name: "build", command: "true" },
      // Passes only in the rebased worktree, which has both the Ticket's file and what landed meanwhile.
      { name: "test", command: "test -e feature.txt && test -e meanwhile.txt" },
    ]),
  });
  const wt = ticket(p, 7, { "feature.txt": "a feature\n" }, { "feature-test.txt": "its test\n" });
  landElsewhere(p, "meanwhile.txt", "landed meanwhile\n", "Landed meanwhile");
  const report = tmpFile(p, "report-7.md", REPORT);

  const r = p.run("land", "7", wt, report);

  assert.equal(r.stderr, "");
  assert.equal(r.code, 0);
  assert.deepEqual(originLog(p), [
    "Adds feature-test.txt. Refs #7",
    "Adds feature.txt. Refs #7",
    "Landed meanwhile",
    "A throwaway Project",
  ]);
  const sha = p.git("--git-dir", p.origin, "rev-parse", "--short", "main");
  const lines = r.stdout.split("\n");
  assert.deepEqual(lines.slice(0, 2), ["ok  build", "ok  test"]);
  assert.match(lines[2], /^Gate passed\. Log: .*\/project\/\.claude\/verkstad\/gate-wt-7-\d{8}-\d{6}\.log$/);
  assert.equal(lines.slice(3).join("\n"), `Landed #7 on main in ${sha} and closed it.\n`);
  const body = `Landed on main in ${sha}.\n\n${REPORT}`;
  assert.deepEqual(p.calls(), [["issue", "close", "7", "--comment", body]]);
  const issue = issueOf(p, 7);
  assert.equal(issue.state, "closed");
  assert.deepEqual(issue.comments, [{ author: "owner", body }]);
  assert.equal(existsSync(wt), false, "the worktree is removed");
  assert.deepEqual(localBranches(p), [], "the branch is deleted");
  assert.equal(p.git("worktree", "list", "--porcelain").includes("wt-7"), false);
  assert.equal(p.git("rev-parse", "main"), originHead(p), "the main checkout, clean on main, is fast-forwarded");
});

test("Landing leaves a main checkout that is not on a clean base branch where it is, and says so", (t) => {
  const p = project(t, { issues: [claimed(7)], contract: contract([{ name: "build", command: "true" }]) });
  const wt = ticket(p, 7, { "feature.txt": "a feature\n" });
  const before = p.git("rev-parse", "main");
  writeFileSync(join(p.dir, "docs", "agents", "project.md"), "# Project, being edited\n");

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^The main checkout is not on a clean main, so it was not fast-forwarded\.$/m);
  assert.equal(p.git("rev-parse", "main"), before);
  assert.equal(originLog(p)[0], "Adds feature.txt. Refs #7");
});

test("a Ticket that was Parked and resumed lands, and its branch on origin is deleted too", (t) => {
  const p = project(t, { issues: [claimed(7)], contract: contract([{ name: "build", command: "true" }]) });
  const wt = ticket(p, 7, { "feature.txt": "a feature\n" });
  p.git("-C", wt, "push", "--quiet", "origin", "issue-7");

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.code, 0, r.stderr);
  assert.equal(originHas(p, "issue-7"), false);
  assert.equal(originLog(p)[0], "Adds feature.txt. Refs #7");
});

test("two Landings started at once run one after the other, and both land", async (t) => {
  const record = "../gate-runs.txt";
  const p = project(t, {
    issues: [claimed(7), claimed(8)],
    contract: contract([
      {
        name: "slow",
        command: `echo "start $(basename "$PWD")" >> ${record}; sleep 1; echo "end $(basename "$PWD")" >> ${record}`,
      },
    ]),
  });
  const wt7 = ticket(p, 7, { "seven.txt": "7\n" });
  const wt8 = ticket(p, 8, { "eight.txt": "8\n" });
  const report = tmpFile(p, "report.md", REPORT);

  const [r7, r8] = await Promise.all([p.start(p.dir, "land", "7", wt7, report), p.start(p.dir, "land", "8", wt8, report)]);

  assert.equal(r7.code, 0, r7.stderr);
  assert.equal(r8.code, 0, r8.stderr);
  const runs = readFileSync(join(p.dir, "..", "gate-runs.txt"), "utf8").trim().split("\n");
  const [first, second] = runs[0] === "start wt-7" ? ["wt-7", "wt-8"] : ["wt-8", "wt-7"];
  assert.deepEqual(runs, [`start ${first}`, `end ${first}`, `start ${second}`, `end ${second}`]);
  const waited = [r7, r8].filter((r) => r.stdout.includes("Waiting for another Landing"));
  assert.equal(waited.length, 1, "the second Landing says it waits for the first");
  assert.deepEqual(originLog(p).slice(0, 2).sort(), ["Adds eight.txt. Refs #8", "Adds seven.txt. Refs #7"]);
  assert.equal(issueOf(p, 7).state, "closed");
  assert.equal(issueOf(p, 8).state, "closed");
  assert.deepEqual(localBranches(p), []);
});

test("when the base moves between rebase and push, the Landing rebases, gates again and pushes", (t) => {
  const p = project(t, {
    issues: [claimed(7)],
    contract: contract([
      // The first Gate run lands another commit on origin, so the first push is rejected.
      {
        name: "moves the base once",
        command:
          "[ -e ../moved ] && exit 0; touch ../moved; git clone -q ../origin.git ../elsewhere && cd ../elsewhere && " +
          "echo meanwhile > meanwhile.txt && git add . && git commit -qm 'Landed during the Gate' && git push -q origin main",
      },
      { name: "has both", command: "echo run >> ../gate-runs.txt" },
    ]),
  });
  const wt = ticket(p, 7, { "feature.txt": "a feature\n" });

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^origin\/main moved during the Gate; rebasing again \(attempt 2 of 3\)\.$/m);
  assert.deepEqual(originLog(p), ["Adds feature.txt. Refs #7", "Landed during the Gate", "A throwaway Project"]);
  assert.equal(readFileSync(join(p.dir, "..", "gate-runs.txt"), "utf8"), "run\nrun\n", "the Gate ran on each rebase");
  assert.equal(issueOf(p, 7).state, "closed");
  assert.equal(existsSync(wt), false);
});

test("a base that keeps moving fails the Landing after three attempts with push-failed", (t) => {
  const p = project(t, {
    issues: [claimed(7)],
    contract: contract([
      {
        name: "moves the base every time",
        command:
          "[ -d ../elsewhere ] || git clone -q ../origin.git ../elsewhere; cd ../elsewhere && git pull -q --ff-only && " +
          "echo x >> meanwhile.txt && git add . && git commit -qm 'Landed during the Gate' && git push -q origin main",
      },
    ]),
  });
  const wt = ticket(p, 7, { "feature.txt": "a feature\n" });
  const branchHead = p.git("rev-parse", "issue-7");

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.code, 1);
  assert.equal(reason(r.stderr), "reason: push-failed");
  assert.match(r.stderr, /^verkstad land: #7 did not land: origin\/main moved during each of 3 Gate runs\.$/m);
  assert.deepEqual(originLog(p), [
    "Landed during the Gate",
    "Landed during the Gate",
    "Landed during the Gate",
    "A throwaway Project",
  ]);
  assert.equal(existsSync(wt), false);
  assert.deepEqual(localBranches(p), ["issue-7"]);
  assert.notEqual(p.git("rev-parse", "issue-7"), branchHead, "the branch keeps its last rebase");
  assert.deepEqual(p.calls(), []);
});

test("a rebase conflict exits with conflict naming the conflicting files; base unchanged, branch kept, no issue closed", (t) => {
  const p = project(t, {
    issues: [claimed(7)],
    contract: contract([{ name: "build", command: "touch ../gate-ran" }]),
    files: { "src/a.txt": "a\n", "src/b.txt": "b\n", "src/c.txt": "c\n" },
  });
  const wt = ticket(
    p,
    7,
    { "src/c.txt": "c from the Ticket\n" },
    { "src/a.txt": "a from the Ticket\n", "src/b.txt": "b from the Ticket\n" },
  );
  landElsewhere(p, "src/a.txt", "a from main\n", "Changes a");
  landElsewhere(p, "src/b.txt", "b from main\n", "Changes b");
  const base = originHead(p);
  const branchHead = p.git("rev-parse", "issue-7");

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.equal(
    r.stderr,
    "verkstad land: #7 did not land: rebasing issue-7 onto origin/main conflicts in src/a.txt, src/b.txt.\n" +
      "Branch issue-7 is kept as it was; its worktree is removed.\n" +
      "reason: conflict\n",
  );
  assert.equal(existsSync(join(p.dir, "..", "gate-ran")), false, "the Gate does not run");
  assertNothingLanded(p, wt, base, branchHead);
});

test("a red Gate exits with gate-failed and the log path; base unchanged, branch kept, no issue closed", (t) => {
  const p = project(t, {
    issues: [claimed(7)],
    contract: contract([
      { name: "build", command: "true" },
      { name: "unit tests", command: "echo 'expected 2, got 3'; exit 3" },
    ]),
  });
  const wt = ticket(p, 7, { "feature.txt": "a feature\n" });
  const base = originHead(p);
  const branchHead = p.git("rev-parse", "issue-7");

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.code, 1);
  assert.equal(r.stdout, "ok  build\n");
  const log = /^Full log: (.*)$/m.exec(r.stderr)?.[1];
  assert.ok(log && existsSync(log), `the Gate log is named and kept:\n${r.stderr}`);
  assert.match(log, /\/project\/\.claude\/verkstad\/gate-wt-7-\d{8}-\d{6}\.log$/);
  assert.equal(
    r.stderr,
    "verkstad land: #7 did not land: the Gate failed: unit tests failed (exit 3). The end of its output:\n" +
      "expected 2, got 3\n" +
      `Full log: ${log}\n` +
      "Branch issue-7 is kept; its worktree is removed.\n" +
      "reason: gate-failed\n",
  );
  assertNothingLanded(p, wt, base, branchHead);
});

test("a branch with nothing to land exits with no-commits; branch kept, no issue closed", (t) => {
  const p = project(t, { issues: [claimed(7)], contract: contract([{ name: "build", command: "true" }]) });
  const wt = ticket(p, 7);
  const base = originHead(p);

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.code, 1);
  assert.equal(reason(r.stderr), "reason: no-commits");
  assert.match(r.stderr, /^verkstad land: #7 did not land: issue-7 has no commits that are not on origin\/main\.$/m);
  assertNothingLanded(p, wt, base, base);
});

test("Landing refuses the main checkout, a worktree on another branch and one with uncommitted changes, touching nothing", (t) => {
  const p = project(t, { issues: [claimed(7)], contract: contract([{ name: "build", command: "touch ../gate-ran" }]) });
  const wt = ticket(p, 7, { "feature.txt": "a feature\n" });
  const other = ticket(p, 8, { "other.txt": "other\n" });
  const report = tmpFile(p, "report-7.md", REPORT);
  const base = originHead(p);

  const refusals: Array<[string[], string]> = [
    [["7", p.dir, report], `${p.dir} is the main checkout, not a worktree`],
    [["7", other, report], `${other} is on branch issue-8, not issue-7`],
    [["7", wt, join(p.dir, "..", "no-report.md")], `no report at ${join(p.dir, "..", "no-report.md")}`],
    [["7", wt, tmpFile(p, "empty.md", "\n")], `the report ${join(p.dir, "..", "empty.md")} is empty`],
    [["7", join(p.dir, "..", "gone"), report], `no worktree at ${join(p.dir, "..", "gone")}`],
    [["7", wt], "usage: verkstad land <n> <worktree> <report-file>"],
    [["seven", wt, report], "usage: verkstad land <n> <worktree> <report-file>"],
  ];
  writeFileSync(join(other, "stray.txt"), "not committed\n");
  refusals.push([["8", other, report], `${other} has uncommitted changes`]);

  for (const [args, why] of refusals) {
    const r = p.run("land", ...args);
    assert.equal(r.code, 2, `land ${args.join(" ")}: ${r.stderr}`);
    assert.ok(r.stderr.startsWith(`verkstad land: refused: ${why}`), r.stderr);
    assert.equal(reason(r.stderr), "reason: refused");
  }
  assert.equal(existsSync(wt), true);
  assert.equal(existsSync(other), true);
  assert.equal(existsSync(join(p.dir, "..", "gate-ran")), false);
  assert.equal(originHead(p), base);
  assert.deepEqual(p.calls(), []);
});

test("Landing refuses a Landing mode it does not know, and pull-request until it is supported", (t) => {
  for (const [landing, why] of [
    ["merge", ".claude/harness.json: landing must be \"push\" or \"pull-request\""],
    ["pull-request", "the Landing mode pull-request is not supported yet; set landing to \"push\""],
  ]) {
    const p = project(t, { issues: [claimed(7)], contract: contract([{ name: "build", command: "true" }], { landing }) });
    const wt = ticket(p, 7, { "feature.txt": "a feature\n" });

    const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

    assert.equal(r.code, 2);
    assert.equal(r.stderr, `verkstad land: refused: ${why}\nreason: refused\n`);
    assert.equal(existsSync(wt), true);
    assert.deepEqual(p.calls(), []);
  }
});

test("when closing the Ticket fails after the push, the Landing still cleans up and exits with github-failed", (t) => {
  const p = project(t, {
    issues: [claimed(7)],
    contract: contract([{ name: "build", command: "true" }]),
    failures: [{ command: "issue close", stderr: "HTTP 502: Bad Gateway" }],
  });
  const wt = ticket(p, 7, { "feature.txt": "a feature\n" });

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.code, 1);
  const sha = p.git("--git-dir", p.origin, "rev-parse", "--short", "main");
  assert.match(r.stderr, new RegExp(`^verkstad land: #7 landed on main in ${sha}, but closing it failed: gh issue close failed: HTTP 502: Bad Gateway`));
  assert.equal(reason(r.stderr), "reason: github-failed");
  assert.equal(originLog(p)[0], "Adds feature.txt. Refs #7");
  assert.equal(existsSync(wt), false);
  assert.deepEqual(localBranches(p), []);
  assert.equal(issueOf(p, 7).state, "open");
});

test("--park pushes the branch over what origin had, removes the worktree, sets needs-info, unassigns and comments why", (t) => {
  const p = project(t, { issues: [claimed(7), claimed(8)], contract: contract([{ name: "build", command: "touch ../gate-ran" }]) });
  const wt = ticket(p, 7, { "feature.txt": "a feature\n" });
  // An earlier Park pushed issue-7; the Resume since rewrote it.
  p.git("push", "--quiet", "origin", "main:refs/heads/issue-7");
  const head = p.git("rev-parse", "issue-7");
  const why = tmpFile(p, "park-7.md", "Blocked: should the export keep layers or flatten them?\n");
  const base = originHead(p);

  const r = p.run("land", "--park", "7", wt, why);

  assert.equal(r.stderr, "");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "Parked #7: branch issue-7 pushed to origin, worktree removed, labelled needs-info.\n");
  assert.equal(originHead(p, "issue-7"), head, "origin's issue-7 is the Ticket's branch");
  assert.equal(originHead(p), base, "the base is untouched");
  assert.equal(existsSync(wt), false);
  assert.deepEqual(localBranches(p), ["issue-7"], "the branch is kept for a Resume");
  assert.equal(existsSync(join(p.dir, "..", "gate-ran")), false, "Parking runs no Gate");
  const short = p.git("rev-parse", "--short", "issue-7");
  const body =
    "Blocked: should the export keep layers or flatten them?\n\n" +
    `Parked: branch \`issue-7\` is on origin at ${short}; a Resume continues from it.`;
  assert.deepEqual(p.calls(), [
    ["issue", "edit", "7", "--remove-label", "ready-for-agent", "--add-label", "needs-info", "--remove-assignee", "@me"],
    ["issue", "comment", "7", "--body", body],
  ]);
  const issue = issueOf(p, 7);
  assert.equal(issue.state, "open");
  assert.deepEqual(issue.labels, ["needs-info"]);
  assert.deepEqual(issue.assignees, []);
  assert.deepEqual(issue.comments, [{ author: "owner", body }]);
  assert.deepEqual(issueOf(p, 8).labels, ["ready-for-agent"]);
});

test("--park after a failed Landing removed the worktree pushes the kept branch and updates the Ticket", (t) => {
  const p = project(t, { issues: [claimed(7)], contract: contract([{ name: "unit tests", command: "exit 1" }]) });
  const wt = ticket(p, 7, { "feature.txt": "a feature\n" });
  const failed = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));
  assert.equal(reason(failed.stderr), "reason: gate-failed");
  assert.equal(existsSync(wt), false);
  const head = p.git("rev-parse", "issue-7");

  const r = p.run("land", "--park", "7", wt, tmpFile(p, "park-7.md", "The Gate failed twice.\n"));

  assert.equal(r.stderr, "");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "Parked #7: branch issue-7 pushed to origin, labelled needs-info.\n");
  assert.equal(originHead(p, "issue-7"), head);
  assert.deepEqual(localBranches(p), ["issue-7"]);
  const issue = issueOf(p, 7);
  assert.deepEqual(issue.labels, ["needs-info"]);
  assert.deepEqual(issue.assignees, []);
  assert.match(issue.comments[0].body, /^The Gate failed twice\.\n\nParked: branch `issue-7` is on origin at [0-9a-f]{7,}; a Resume continues from it\.$/);
});

test("--park with neither the worktree nor the branch refuses", (t) => {
  const p = project(t, { issues: [claimed(7)], contract: contract([{ name: "build", command: "true" }]) });
  const gone = join(p.dir, "..", "wt-7");

  const r = p.run("land", "--park", "7", gone, tmpFile(p, "park-7.md", "Stuck.\n"));

  assert.equal(r.code, 2);
  assert.equal(r.stderr, `verkstad land: refused: no worktree at ${gone}, and no branch issue-7 in the Project here\nreason: refused\n`);
  assert.deepEqual(p.calls(), []);
});

test("--park refuses a worktree with uncommitted changes, which removing it would lose", (t) => {
  const p = project(t, { issues: [claimed(7)], contract: contract([{ name: "build", command: "true" }]) });
  const wt = ticket(p, 7, { "feature.txt": "a feature\n" });
  writeFileSync(join(wt, "half-done.txt"), "not committed\n");

  const r = p.run("land", "--park", "7", wt, tmpFile(p, "park-7.md", "Ran out of turns.\n"));

  assert.equal(r.code, 2);
  assert.equal(r.stderr, `verkstad land: refused: ${wt} has uncommitted changes\nreason: refused\n`);
  assert.equal(existsSync(wt), true);
  assert.equal(originHas(p, "issue-7"), false);
  assert.deepEqual(p.calls(), []);
});

/** Puts an entry in the log directory, last modified `daysAgo` days ago. */
function logEntry(p: Project, path: string, daysAgo: number, content = "log\n"): void {
  const full = join(p.dir, ".claude", "verkstad", path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  const when = new Date(Date.now() - daysAgo * DAY);
  utimesSync(full, when, when);
}

function age(p: Project, path: string, daysAgo: number): void {
  const when = new Date(Date.now() - daysAgo * DAY);
  utimesSync(join(p.dir, ".claude", "verkstad", path), when, when);
}

test("prune deletes log-directory entries older than 30 days and keeps newer ones", (t) => {
  const p = project(t);
  logEntry(p, "gate-wt-3-20260801-101010.log", 45);
  logEntry(p, "gate-wt-4-20260901-101010.log", 29);
  logEntry(p, "evidence-3/screenshot.png", 40);
  age(p, "evidence-3", 40);
  // A directory last changed long ago, holding something recent, is still in use.
  logEntry(p, "evidence-5/old.png", 60);
  logEntry(p, "evidence-5/new/today.png", 0);
  age(p, "evidence-5", 60);

  const r = p.run("prune");

  assert.equal(r.stderr, "");
  assert.equal(r.code, 0);
  const dir = join(p.dir, ".claude", "verkstad");
  assert.equal(r.stdout, `Pruned 2 entries older than 30 days from ${dir}:\n  evidence-3\n  gate-wt-3-20260801-101010.log\n`);
  assert.deepEqual(readdirSync(dir).sort(), ["evidence-5", "gate-wt-4-20260901-101010.log"]);
  assert.deepEqual(readdirSync(join(dir, "evidence-5")).sort(), ["new", "old.png"]);
  assert.deepEqual(p.calls(), []);

  const again = p.run("prune");
  assert.equal(again.stdout, `Nothing older than 30 days in ${dir}.\n`);
});

test("a Landing prunes the log directory once it has landed", (t) => {
  const p = project(t, { issues: [claimed(7)], contract: contract([{ name: "build", command: "true" }]) });
  logEntry(p, "gate-wt-3-20260801-101010.log", 31);
  const wt = ticket(p, 7, { "feature.txt": "a feature\n" });

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Pruned 1 entry older than 30 days from .*:\n {2}gate-wt-3-20260801-101010\.log\n/m);
  assert.equal(existsSync(join(p.dir, ".claude", "verkstad", "gate-wt-3-20260801-101010.log")), false);
});
