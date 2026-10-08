import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { project, type Project } from "./project.ts";
import type { StubIssue } from "./stub/state.ts";

const REPORT = "status: done\nWhat was built: the feature.\n";
const DAY = 24 * 60 * 60 * 1000;

interface Step {
  name: string;
  command: string;
  unlessExists?: string;
  quick?: { files: string; env: string };
}

/** A Contract whose Gate has these steps. Steps run from the worktree root, which sits beside the
 * main checkout (`../project`) and the bare origin (`../origin.git`) in the test's temp dir. */
function contract(steps: Step[], fields: Record<string, unknown> = {}): object {
  return { baseBranch: "main", gate: { steps }, surfaces: [], ...fields };
}

/** An open Ticket a Run has claimed. */
function claimed(number: number): Partial<StubIssue> & { number: number } {
  return { number, labels: ["ready-for-agent"], assignees: ["owner"] };
}

/** A file in the test's temp dir, beside the main checkout. */
function tmpFile(p: Project, name: string, content: string): string {
  const path = join(p.dir, "..", name);
  writeFileSync(path, content);
  return path;
}

/** A Ticket's worktree as an implementing agent leaves it: branch issue-<n> off main, a commit per file set,
 * reviewed at its last commit. */
function ticket(p: Project, n: number, ...commits: Array<Record<string, string>>): string {
  const wt = unreviewed(p, n, ...commits);
  recordReview(p, wt);
  return wt;
}

/** A Ticket's worktree whose branch has no recorded review, as an implementer that skipped verkstad:review leaves it. */
function unreviewed(p: Project, n: number, ...commits: Array<Record<string, string>>): string {
  const wt = join(p.dir, "..", `wt-${n}`);
  p.git("worktree", "add", "--quiet", "-b", `issue-${n}`, wt, "main");
  for (const files of commits) commit(p, wt, files, `Adds ${Object.keys(files).join(", ")}. Refs #${n}`);
  return wt;
}

/** Adds a commit of these files to the worktree's branch. */
function commit(p: Project, wt: string, files: Record<string, string>, message: string): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(wt, path)), { recursive: true });
    writeFileSync(join(wt, path), content);
    p.git("-C", wt, "add", path);
  }
  p.git("-C", wt, "commit", "--quiet", "-m", message);
}

/** Records, as verkstad:review does, that the worktree's branch was reviewed at the commit it is on. */
function recordReview(p: Project, wt: string): void {
  const r = p.runIn(wt, "review", "record");
  assert.equal(r.code, 0, r.stderr);
}

/** The file Landing looks for a review of issue-<n> in. */
function reviewPath(p: Project, n: number): string {
  return join(p.dir, ".claude", "verkstad", `review-issue-${n}.json`);
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

/** The last line of a failed Landing's stderr: the reason a Run routes on. */
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

test("with no Landing mode in the Contract, a clean branch lands: rebased onto the latest base, gated in full, pushed, the Ticket closed with the report, worktree and branch gone", (t) => {
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
  const body = `Landed on main in ${sha}.\n\n${REPORT}\nVerification state: test-verified. Surfaces: none.\n`;
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
  assert.match(r.stderr, /^Branch issue-7 is kept, rebased, in its worktree\.\nreason: push-failed\n$/m);
  assert.equal(existsSync(wt), true);
  assert.equal(p.git("-C", wt, "status", "--porcelain"), "");
  assert.deepEqual(localBranches(p), ["issue-7"]);
  assert.notEqual(p.git("rev-parse", "issue-7"), branchHead, "the branch keeps its last rebase");
  assert.deepEqual(p.calls(), []);
});

test("origin refusing the push in push mode fails with push-failed; the worktree is kept and landing again from it lands", (t) => {
  const p = project(t, { issues: [claimed(7)], contract: contract([{ name: "build", command: "true" }]) });
  const wt = ticket(p, 7, { "feature.txt": "a feature\n" });
  landElsewhere(p, "other.txt", "other\n", "Lands on main");
  const hook = join(p.origin, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\necho 'origin is having a bad day' >&2\nexit 1\n", { mode: 0o755 });
  const base = originHead(p);

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.code, 1);
  assert.match(r.stderr, /^verkstad land: #7 did not land: pushing to origin\/main failed: .*origin is having a bad day/m);
  assert.match(r.stderr, /^Branch issue-7 is kept, rebased, in its worktree\.\nreason: push-failed\n$/m);
  assert.equal(originHead(p), base);
  assert.equal(existsSync(wt), true);
  assert.equal(p.git("-C", wt, "status", "--porcelain"), "");
  assert.equal(p.git("-C", wt, "log", "--format=%s", "-2"), "Adds feature.txt. Refs #7\nLands on main");

  rmSync(hook);
  const again = p.run("land", "7", wt, tmpFile(p, "report-7b.md", REPORT));

  assert.equal(again.code, 0, again.stderr);
  assert.equal(issueOf(p, 7).state, "closed");
  assert.equal(existsSync(wt), false);
  assert.deepEqual(originLog(p).slice(0, 2), ["Adds feature.txt. Refs #7", "Lands on main"]);
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

test("a branch with no recorded review exits with review-missing before the rebase and the Gate; Ticket, branch, worktree and origin untouched", (t) => {
  const p = project(t, { issues: [claimed(7)], contract: contract([{ name: "build", command: "touch ../gate-ran" }]) });
  const wt = unreviewed(p, 7, { "feature.txt": "a feature\n" });
  const head = p.git("rev-parse", "issue-7");
  landElsewhere(p, "meanwhile.txt", "landed meanwhile\n", "Landed meanwhile");
  const base = originHead(p);

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.equal(
    r.stderr,
    `verkstad land: #7 did not land: no review of issue-7 is recorded: there is no ${reviewPath(p, 7)}. ` +
      "Running verkstad:review on the branch records one.\n" +
      "Branch issue-7 is kept as it was, in its worktree.\n" +
      "reason: review-missing\n",
  );
  assert.equal(existsSync(join(p.dir, "..", "gate-ran")), false, "the Gate did not run");
  assert.equal(originHead(p), base, "origin's main is unchanged");
  assert.equal(originHas(p, "issue-7"), false, "nothing was pushed");
  assert.equal(p.git("-C", wt, "rev-parse", "HEAD"), head, "the branch is not rebased");
  assert.equal(p.git("-C", wt, "branch", "--show-current"), "issue-7", "the worktree is still on the branch");
  assert.equal(p.git("-C", wt, "status", "--porcelain"), "");
  assert.deepEqual(p.calls(), [], "no issue was touched");
  assert.equal(issueOf(p, 7).state, "open");
  assert.deepEqual(issueOf(p, 7).assignees, ["owner"]);
});

test("a review record that is not valid JSON or names another branch is no recorded review: review-missing", (t) => {
  const cases = [
    // JSON.parse's own message follows the colon, so only this case's first line is matched, not spelt out.
    { content: "{not json", why: (path: string) => new RegExp(`^verkstad land: #7 did not land: no review of issue-7 is recorded: ${path} is not valid JSON: .+\\. Running`) },
    {
      content: '{"branch": "issue-8", "commit": "0123456789abcdef0123456789abcdef01234567"}',
      why: (path: string) => `${path} names the branch "issue-8", not issue-7`,
    },
    { content: '{"branch": "issue-7"}', why: (path: string) => `${path} names no commit: its commit is undefined` },
  ];
  for (const { content, why } of cases) {
    const p = project(t, { issues: [claimed(7)], contract: contract([{ name: "build", command: "true" }]) });
    const wt = unreviewed(p, 7, { "feature.txt": "a feature\n" });
    const path = reviewPath(p, 7);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);

    const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

    assert.equal(r.code, 1, content);
    const expected = why(path);
    if (typeof expected === "string") {
      assert.equal(
        r.stderr,
        `verkstad land: #7 did not land: no review of issue-7 is recorded: ${expected}. Running verkstad:review on the branch records one.\n` +
          "Branch issue-7 is kept as it was, in its worktree.\nreason: review-missing\n",
      );
    } else {
      assert.match(r.stderr, expected);
      assert.equal(reason(r.stderr), "reason: review-missing");
    }
    assert.equal(existsSync(wt), true, "the worktree is kept");
  }
});

test("a review recorded on an earlier commit of the branch lands it, and the Landing deletes the record with the branch", (t) => {
  const p = project(t, { issues: [claimed(7)], contract: contract([{ name: "build", command: "true" }]) });
  const wt = ticket(p, 7, { "feature.txt": "a feature\n" });
  commit(p, wt, { "fix.txt": "the review's fix\n" }, "Fixes what the review found. Refs #7");
  landElsewhere(p, "meanwhile.txt", "landed meanwhile\n", "Landed meanwhile");

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(originLog(p).slice(0, 3), ["Fixes what the review found. Refs #7", "Adds feature.txt. Refs #7", "Landed meanwhile"]);
  assert.equal(issueOf(p, 7).state, "closed");
  assert.equal(existsSync(reviewPath(p, 7)), false, "the review record is deleted");
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

test("Landing refuses a Landing mode it does not know, touching nothing", (t) => {
  const p = project(t, { issues: [claimed(7)], contract: contract([{ name: "build", command: "true" }], { landing: "merge" }) });
  const wt = ticket(p, 7, { "feature.txt": "a feature\n" });

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.code, 2);
  assert.equal(r.stderr, 'verkstad land: refused: .claude/harness.json: landing must be "push" or "pull-request"\nreason: refused\n');
  assert.equal(existsSync(wt), true);
  assert.deepEqual(p.calls(), []);
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

/** Leaves, as an implementing agent may, scratch notes and Walk evidence under the worktree's gitignored .claude/verkstad/. */
function leaveNotes(wt: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const file = join(wt, ".claude", "verkstad", path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

/** The log directory's entries, sorted; none when it does not exist. */
function logEntries(p: Project): string[] {
  const dir = join(p.dir, ".claude", "verkstad");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

test("a Landing removes the worktree with what the agent left under its .claude/verkstad/, keeping none of it", (t) => {
  const p = project(t, { issues: [claimed(7)], contract: contract([{ name: "build", command: "true" }]) });
  const wt = ticket(p, 7, { "feature.txt": "a feature\n" });
  leaveNotes(wt, { "notes-7.md": "this agent's notes\n", "evidence/7/walk.txt": "what the Walk saw\n" });

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.stderr, "");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /\nLanded #7 on main in [0-9a-f]+ and closed it\.\n$/);
  assert.doesNotMatch(r.stdout, /Moved/);
  assert.equal(existsSync(wt), false, "the worktree is removed");
  assert.deepEqual(logEntries(p).filter((e) => /notes|evidence/.test(e)), []);
});

test("--park and a failed Landing remove the worktree with what the agent left there too", (t) => {
  const p = project(t, { issues: [claimed(7), claimed(8)], contract: contract([{ name: "unit tests", command: "test ! -e broken.txt" }]) });
  const parked = ticket(p, 7, { "feature.txt": "a feature\n" });
  leaveNotes(parked, { "notes-7.md": "notes\n" });
  const failed = ticket(p, 8, { "broken.txt": "x\n" });
  leaveNotes(failed, { "notes-8.md": "notes\n" });

  const park = p.run("land", "--park", "7", parked, tmpFile(p, "park-7.md", "Stuck.\n"));
  const land = p.run("land", "8", failed, tmpFile(p, "report-8.md", REPORT));

  assert.equal(park.stdout, "Parked #7: branch issue-7 pushed to origin, worktree removed, labelled needs-info.\n");
  assert.equal(reason(land.stderr), "reason: gate-failed");
  assert.equal(existsSync(parked) || existsSync(failed), false, "both worktrees are removed");
  assert.deepEqual(logEntries(p).filter((e) => e.startsWith("notes")), []);
});

const UI = [{ name: "ui", globs: ["src/ui/**"] }];
const CRITERIA = [
  { criterion: "The panel shows the job's time", seen: "Opened the panel: it read 3 min 12 s." },
  { criterion: "Export saves an SVG", seen: "Clicked Export; out.svg opened with both layers." },
];

/** Records the Verifier's Verdict for the Ticket in `wt`, as the Verifier does. */
function recordVerdict(p: Project, n: number, wt: string, state: string): void {
  const criteria = tmpFile(p, `criteria-${n}.json`, JSON.stringify(CRITERIA));
  const r = p.run("verdict", "record", String(n), wt, "--state", state, "--criteria", criteria);
  assert.equal(r.code, 0, r.stderr);
}

/** The patch-id of the branch checked out in `cwd`, computed the way docs/verdict.md spells it out. */
function branchPatchId(p: Project, cwd: string): string {
  const r = spawnSync("bash", ["-c", "git diff $(git merge-base origin/main HEAD) HEAD | git patch-id --stable"], {
    cwd,
    env: p.env,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split(" ")[0];
}

/** Asserts a Landing stopped by its Verdict check left everything but the rebase as it was. */
function assertStoppedByVerdict(p: Project, wt: string, base: string): void {
  assert.equal(originHead(p), base, "origin's main is unchanged");
  assert.equal(existsSync(wt), true, "the worktree is kept for the Verifier");
  assert.equal(p.git("-C", wt, "branch", "--show-current"), "issue-7");
  assert.equal(p.git("-C", wt, "status", "--porcelain"), "");
  assert.deepEqual(localBranches(p), ["issue-7"], "the branch is kept");
  assert.deepEqual(p.calls(), [], "no issue was touched");
  assert.equal(issueOf(p, 7).state, "open");
}

/** A Gate step that counts its runs in `../gate-runs.txt`, beside the main checkout. */
const COUNTED: Step = { name: "build", command: "echo run >> ../gate-runs.txt" };

test("a Ticket touching a Surface with no Verdict exits with verdict-missing before the Gate runs a step; base unchanged, branch kept, no issue closed", (t) => {
  const p = project(t, {
    issues: [claimed(7)],
    contract: contract([COUNTED], { surfaces: UI }),
  });
  const wt = ticket(p, 7, { "src/ui/panel.ts": "panel\n" });
  const base = originHead(p);

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.equal(gateRuns(p), 0, "no Gate step ran");
  assert.equal(
    r.stderr,
    `verkstad land: #7 did not land: #7 touches the Surface ui, and has no Verdict: there is no ${join(p.dir, ".claude", "verkstad", "verdict-7.json")}.\n` +
      "Branch issue-7 is kept, rebased, in its worktree.\n" +
      "reason: verdict-missing\n",
  );
  assertStoppedByVerdict(p, wt, base);
});

test("a test-verified, blocked or failed Verdict does not land a Ticket touching a Surface: verdict-not-live, before the Gate runs a step", (t) => {
  for (const state of ["test-verified", "blocked", "failed"]) {
    const p = project(t, {
      issues: [claimed(7)],
      contract: contract([COUNTED], { surfaces: UI }),
    });
    const wt = ticket(p, 7, { "src/ui/panel.ts": "panel\n" });
    recordVerdict(p, 7, wt, state);
    const base = originHead(p);

    const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

    assert.equal(r.code, 1, state);
    assert.equal(r.stdout, "", state);
    assert.equal(gateRuns(p), 0, `${state}: no Gate step ran`);
    assert.equal(
      r.stderr,
      `verkstad land: #7 did not land: #7 touches the Surface ui, and its Verdict is ${state}, not live-verified.\n` +
        "Branch issue-7 is kept, rebased, in its worktree.\n" +
        "reason: verdict-not-live\n",
    );
    assertStoppedByVerdict(p, wt, base);
  }
});

test("a clean rebase keeps a live-verified Verdict valid, and the Ticket closes with the Verdict after the report", (t) => {
  const p = project(t, {
    issues: [claimed(7)],
    contract: contract([{ name: "build", command: "true" }], { surfaces: UI }),
    files: { "src/ui/panel.ts": "panel\n" },
  });
  const wt = ticket(p, 7, { "src/ui/panel.ts": "panel, with the job's time\n" }, { "src/ui/export.ts": "export\n" });
  recordVerdict(p, 7, wt, "live-verified");
  const given = branchPatchId(p, wt);
  const before = p.git("rev-parse", "issue-7");
  landElsewhere(p, "meanwhile.txt", "landed meanwhile\n", "Landed meanwhile");

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(originLog(p), ["Adds src/ui/export.ts. Refs #7", "Adds src/ui/panel.ts. Refs #7", "Landed meanwhile", "A throwaway Project"]);
  assert.notEqual(p.git("--git-dir", p.origin, "rev-parse", "main"), before, "the branch was rebased");
  const sha = p.git("--git-dir", p.origin, "rev-parse", "--short", "main");
  const evidence = join(p.dir, ".claude", "verkstad", "evidence-7");
  const body =
    `Landed on main in ${sha}.\n\n${REPORT}\n` +
    `Verification state: live-verified. Surfaces: ui. Evidence: \`${evidence}\`.\n\n` +
    "- The panel shows the job's time: Opened the panel: it read 3 min 12 s.\n" +
    "- Export saves an SVG: Clicked Export; out.svg opened with both layers.\n";
  assert.deepEqual(p.calls(), [["issue", "close", "7", "--comment", body]]);
  assert.equal(issueOf(p, 7).state, "closed");
  const landed = spawnSync("bash", ["-c", `git --git-dir '${p.origin}' diff main~2 main | git patch-id --stable`], {
    env: p.env,
    encoding: "utf8",
  });
  assert.equal(landed.stdout.split(" ")[0], given, "the landed, rebased patch has the Verdict's patch-id");
});

test("a conflict resolution that changes the patch voids the Verdict: land exits with verdict-void before the Gate runs a step; base unchanged, branch kept, no issue closed", (t) => {
  const p = project(t, {
    issues: [claimed(7)],
    contract: contract([COUNTED], { surfaces: UI }),
    files: { "src/ui/panel.ts": "panel\n" },
  });
  const wt = ticket(p, 7, { "src/ui/panel.ts": "panel, with the job's time\n" });
  recordVerdict(p, 7, wt, "live-verified");
  const given = branchPatchId(p, wt);
  landElsewhere(p, "src/ui/panel.ts", "panel, with a title\n", "Titles the panel");
  const first = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));
  assert.equal(reason(first.stderr), "reason: conflict");
  // The conflict is resolved, as the conflict agent would, by keeping both changes.
  p.git("worktree", "add", "--quiet", wt, "issue-7");
  p.git("-C", wt, "fetch", "--quiet", "origin");
  assert.throws(() => p.git("-C", wt, "rebase", "--quiet", "origin/main"));
  writeFileSync(join(wt, "src", "ui", "panel.ts"), "panel, with a title and the job's time\n");
  p.git("-C", wt, "add", "src/ui/panel.ts");
  p.git("-C", wt, "-c", "core.editor=true", "rebase", "--continue");
  const resolved = branchPatchId(p, wt);
  assert.notEqual(resolved, given);
  const base = originHead(p);

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.equal(gateRuns(p), 0, "no Gate step ran");
  assert.equal(
    r.stderr,
    `verkstad land: #7 did not land: #7 touches the Surface ui, and its Verdict is void: it was given for patch ${given.slice(0, 12)}, ` +
      `but the branch is now patch ${resolved.slice(0, 12)}. The changed patch needs a new Verdict.\n` +
      "Branch issue-7 is kept, rebased, in its worktree.\n" +
      "reason: verdict-void\n",
  );
  assertStoppedByVerdict(p, wt, base);
});

test("a Ticket touching no Surface lands whatever its Verdict says, and closes test-verified with that Verdict shown", (t) => {
  const p = project(t, {
    issues: [claimed(7)],
    contract: contract([{ name: "build", command: "true" }], { surfaces: UI }),
  });
  const wt = ticket(p, 7, { "src/core/time.ts": "time\n" });
  recordVerdict(p, 7, wt, "failed");

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.code, 0, r.stderr);
  const sha = p.git("--git-dir", p.origin, "rev-parse", "--short", "main");
  const evidence = join(p.dir, ".claude", "verkstad", "evidence-7");
  const body =
    `Landed on main in ${sha}.\n\n${REPORT}\n` +
    `Verification state: test-verified. Surfaces: none. The Verifier's Verdict for this patch was failed. Evidence: \`${evidence}\`.\n\n` +
    "- The panel shows the job's time: Opened the panel: it read 3 min 12 s.\n" +
    "- Export saves an SVG: Clicked Export; out.svg opened with both layers.\n";
  assert.deepEqual(p.calls(), [["issue", "close", "7", "--comment", body]]);
  assert.equal(originLog(p)[0], "Adds src/core/time.ts. Refs #7");
});

test("Landing refuses a Contract whose surfaces are malformed, touching nothing", (t) => {
  const p = project(t, { issues: [claimed(7)], contract: contract([{ name: "build", command: "touch ../gate-ran" }], { surfaces: "src/ui" }) });
  const wt = ticket(p, 7, { "src/ui/panel.ts": "panel\n" });

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.code, 2);
  assert.equal(
    r.stderr,
    "verkstad land: refused: .claude/harness.json: surfaces must be an array of Surfaces ([] for a Project with none)\nreason: refused\n",
  );
  assert.equal(existsSync(join(p.dir, "..", "gate-ran")), false);
  assert.equal(existsSync(wt), true);
  assert.deepEqual(p.calls(), []);
});

/** A Contract with two Surfaces and a Verify skill, which a branch may widen but not narrow. */
const CHECKED = {
  surfaces: [
    { name: "ui", globs: ["src/ui/**", "docs/ui.md"] },
    { name: "api", globs: ["server/**"] },
  ],
  verify: "verify-app",
};

/** Asserts a Landing refused by contract-narrowed changed nothing: no rebase, no Gate, worktree, branch and Ticket as they were. */
function assertNothingChanged(p: Project, wt: string, base: string, head: string): void {
  assert.equal(gateRuns(p), 0, "no Gate step ran");
  assert.equal(originHead(p), base, "origin's main is unchanged");
  assert.equal(originHas(p, "issue-7"), false, "nothing was pushed");
  assert.equal(p.git("-C", wt, "rev-parse", "HEAD"), head, "the branch is not rebased");
  assert.equal(p.git("-C", wt, "branch", "--show-current"), "issue-7", "the worktree is still on the branch");
  assert.equal(p.git("-C", wt, "status", "--porcelain"), "");
  assert.deepEqual(p.calls(), [], "no issue was touched");
  assert.equal(issueOf(p, 7).state, "open");
  assert.deepEqual(issueOf(p, 7).assignees, ["owner"]);
}

test("a branch that narrows the Contract's Surfaces or changes verify exits with contract-narrowed naming each narrowing, before the rebase and the Gate; nothing changes", (t) => {
  const cases: Array<{ branch: Record<string, unknown>; narrowings: string }> = [
    {
      branch: {
        surfaces: [{ name: "ui", globs: ["src/ui/**", "!src/ui/**/*.test.ts", "index.html"] }],
        verify: "verify-other",
      },
      narrowings:
        "it removes the glob docs/ui.md from the Surface ui; adds the glob !src/ui/**/*.test.ts to the Surface ui; " +
        "removes the Surface api; changes verify from verify-app to verify-other",
    },
    {
      branch: { surfaces: CHECKED.surfaces },
      narrowings: "it removes verify (verify-app)",
    },
  ];
  for (const { branch, narrowings } of cases) {
    const p = project(t, { issues: [claimed(7)], contract: contract([COUNTED], CHECKED) });
    const wt = ticket(p, 7, { ".claude/harness.json": JSON.stringify(contract([COUNTED], branch), null, 2) });
    const head = p.git("rev-parse", "issue-7");
    landElsewhere(p, "meanwhile.txt", "landed meanwhile\n", "Landed meanwhile");
    const base = originHead(p);

    const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

    assert.equal(r.code, 1, narrowings);
    assert.equal(r.stdout, "");
    assert.equal(
      r.stderr,
      `verkstad land: #7 did not land: issue-7 narrows the Contract: ${narrowings}.\n` +
        "Branch issue-7 is kept as it was, in its worktree.\n" +
        "reason: contract-narrowed\n",
    );
    assertNothingChanged(p, wt, base, head);
  }
});

test("a branch that adds a Surface, a glob to one and verify where there was none lands as before", (t) => {
  const before = { surfaces: [{ name: "ui", globs: ["src/ui/**", "!src/ui/**/*.test.ts"] }] };
  const after = {
    surfaces: [
      { name: "ui", globs: ["src/ui/**", "index.html"] },
      { name: "api", globs: ["server/**", "!server/**/*.test.ts"] },
    ],
    verify: "verify-app",
  };
  const p = project(t, { issues: [claimed(7)], contract: contract([COUNTED], before) });
  const wt = ticket(p, 7, { ".claude/harness.json": JSON.stringify(contract([COUNTED], after), null, 2) }, { "src/core/time.ts": "time\n" });

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.code, 0, r.stderr);
  assert.equal(gateRuns(p), 1);
  assert.deepEqual(originLog(p).slice(0, 2), ["Adds src/core/time.ts. Refs #7", "Adds .claude/harness.json. Refs #7"]);
  assert.equal(issueOf(p, 7).state, "closed");
});

test("a Surface the owner added on the base after the branch left it is not one the branch removed: the branch lands", (t) => {
  const p = project(t, { issues: [claimed(7)], contract: contract([COUNTED], CHECKED) });
  const wt = ticket(p, 7, { "src/core/time.ts": "time\n" });
  const added = contract([COUNTED], { ...CHECKED, surfaces: [...CHECKED.surfaces, { name: "cli", globs: ["bin/**"] }] });
  landElsewhere(p, ".claude/harness.json", JSON.stringify(added, null, 2), "Adds the Surface cli");
  p.git("fetch", "--quiet", "origin");

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(originLog(p).slice(0, 2), ["Adds src/core/time.ts. Refs #7", "Adds the Surface cli"]);
});

test("a base whose Surfaces are malformed has nothing to narrow: a branch that fixes them lands", (t) => {
  const p = project(t, { issues: [claimed(7)], contract: contract([COUNTED], { surfaces: "src/ui" }) });
  const wt = ticket(p, 7, { ".claude/harness.json": JSON.stringify(contract([COUNTED], { surfaces: [] }), null, 2) });

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.code, 0, r.stderr);
  assert.equal(originLog(p)[0], "Adds .claude/harness.json. Refs #7");
});

const PR_MODE = { landing: "pull-request" };

/** The `gh pr list` call a pull-request Landing makes to find the Ticket's open pull request. */
const LIST_PRS = ["pr", "list", "--head", "issue-7", "--base", "main", "--state", "open", "--json", "number,url"];

test("in pull-request mode a clean branch is rebased, gated in full, pushed as issue-<n> and opened as a pull request that closes the Ticket on merge; the base is unchanged and the Ticket stays open", (t) => {
  const p = project(t, {
    issues: [{ ...claimed(7), title: "Show the job's time" }],
    contract: contract(
      [
        { name: "build", command: "true" },
        { name: "test", command: "test -e feature.txt && test -e meanwhile.txt" },
      ],
      PR_MODE,
    ),
  });
  const wt = ticket(p, 7, { "feature.txt": "a feature\n" });
  landElsewhere(p, "meanwhile.txt", "landed meanwhile\n", "Landed meanwhile");
  const base = originHead(p);
  const mainBefore = p.git("rev-parse", "main");

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.stderr, "");
  assert.equal(r.code, 0);
  assert.equal(originHead(p), base, "origin's main is unchanged");
  assert.equal(p.git("--git-dir", p.origin, "log", "--format=%s", "issue-7", "-2"), "Adds feature.txt. Refs #7\nLanded meanwhile");
  assert.equal(p.git("--git-dir", p.origin, "rev-parse", "issue-7~1"), base, "origin's issue-7 is the branch rebased onto the base");
  const sha = p.git("--git-dir", p.origin, "rev-parse", "--short", "issue-7");
  const lines = r.stdout.split("\n");
  assert.deepEqual(lines.slice(0, 2), ["ok  build", "ok  test"]);
  assert.match(lines[2], /^Gate passed\. Log: /);
  assert.equal(
    lines.slice(3).join("\n"),
    `Opened https://github.com/owner/project/pull/8 onto main for #7 (issue-7 at ${sha}); #7 closes when it merges.\n`,
  );
  const body = `Closes #7.\n\n${REPORT}\nVerification state: test-verified. Surfaces: none.\n`;
  assert.deepEqual(p.calls(), [
    LIST_PRS,
    ["api", "repos/{owner}/{repo}/issues/7"],
    ["pr", "create", "--base", "main", "--head", "issue-7", "--title", "Show the job's time", "--body", body],
  ]);
  assert.deepEqual(p.state().pullRequests, [
    { number: 8, title: "Show the job's time", body, state: "open", head: "issue-7", base: "main" },
  ]);
  const issue = issueOf(p, 7);
  assert.equal(issue.state, "open");
  assert.deepEqual(issue.assignees, ["owner"], "the Ticket stays assigned, so no Run dispatches it again");
  assert.deepEqual(issue.labels, ["ready-for-agent"]);
  assert.deepEqual(issue.comments, []);
  assert.equal(existsSync(wt), false, "the worktree is removed");
  assert.deepEqual(localBranches(p), [], "the local branch is deleted; the pull request's is on origin");
  assert.equal(existsSync(reviewPath(p, 7)), false, "the review record goes with the local branch");
  assert.equal(p.git("rev-parse", "main"), mainBefore, "the main checkout is left where it was");
});

test("in pull-request mode a Ticket whose pull request is open gets its branch force-pushed and the pull request's body replaced, with the Verdict", (t) => {
  const p = project(t, {
    issues: [{ ...claimed(7), title: "Show the job's time" }],
    pullRequests: [
      { number: 12, title: "Show the job's time", body: "Closes #7.\n\nThe first report.", state: "open", head: "issue-7", base: "main" },
      { number: 10, title: "An older try", body: "", state: "closed", head: "issue-7", base: "main" },
      { number: 11, title: "A backport", body: "Onto release.", state: "open", head: "issue-7", base: "release" },
    ],
    contract: contract([{ name: "build", command: "true" }], { ...PR_MODE, surfaces: UI }),
    files: { "src/ui/panel.ts": "panel\n" },
  });
  const wt = ticket(p, 7, { "src/ui/panel.ts": "panel, with the job's time\n" });
  // An earlier Landing pushed issue-7 and opened #12; the base moved since, so the rebased branch is not a fast-forward of it.
  p.git("-C", wt, "push", "--quiet", "origin", "issue-7");
  const earlier = originHead(p, "issue-7");
  landElsewhere(p, "meanwhile.txt", "landed meanwhile\n", "Landed meanwhile");
  recordVerdict(p, 7, wt, "live-verified");
  const base = originHead(p);

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.code, 0, r.stderr);
  assert.equal(originHead(p), base);
  assert.notEqual(originHead(p, "issue-7"), earlier, "origin's issue-7 is replaced");
  assert.equal(p.git("--git-dir", p.origin, "rev-parse", "issue-7~1"), base);
  const sha = p.git("--git-dir", p.origin, "rev-parse", "--short", "issue-7");
  assert.equal(
    r.stdout.split("\n").slice(2).join("\n"),
    `Updated https://github.com/owner/project/pull/12 onto main for #7 (issue-7 at ${sha}); #7 closes when it merges.\n`,
  );
  const evidence = join(p.dir, ".claude", "verkstad", "evidence-7");
  const body =
    `Closes #7.\n\n${REPORT}\n` +
    `Verification state: live-verified. Surfaces: ui. Evidence: \`${evidence}\`.\n\n` +
    "- The panel shows the job's time: Opened the panel: it read 3 min 12 s.\n" +
    "- Export saves an SVG: Clicked Export; out.svg opened with both layers.\n";
  assert.deepEqual(p.calls(), [LIST_PRS, ["pr", "edit", "12", "--body", body]]);
  assert.deepEqual(
    p.state().pullRequests.map((pr) => [pr.number, pr.state, pr.body]),
    [
      [12, "open", body],
      [10, "closed", ""],
      [11, "open", "Onto release."],
    ],
  );
  assert.equal(issueOf(p, 7).state, "open");
  assert.equal(existsSync(wt), false);
  assert.deepEqual(localBranches(p), []);
});

test("in pull-request mode a conflict, a red Gate and a missing Verdict fail as in push mode: same reason, nothing pushed, no pull request", (t) => {
  const scenarios: Array<{
    name: string;
    gate: Step[];
    surfaces?: object[];
    files?: Record<string, string>;
    branch: Record<string, string>;
    elsewhere?: [string, string];
    stderr: (p: Project) => RegExp;
    reason: string;
    worktreeKept: boolean;
  }> = [
    {
      name: "conflict",
      gate: [{ name: "build", command: "true" }],
      files: { "src/a.txt": "a\n" },
      branch: { "src/a.txt": "a from the Ticket\n" },
      elsewhere: ["src/a.txt", "a from main\n"],
      stderr: () =>
        /^verkstad land: #7 did not land: rebasing issue-7 onto origin\/main conflicts in src\/a\.txt\.\nBranch issue-7 is kept as it was; its worktree is removed\.\nreason: conflict\n$/,
      reason: "conflict",
      worktreeKept: false,
    },
    {
      name: "red Gate",
      gate: [{ name: "unit tests", command: "echo 'expected 2, got 3'; exit 3" }],
      branch: { "feature.txt": "a feature\n" },
      stderr: () =>
        /^verkstad land: #7 did not land: the Gate failed: unit tests failed \(exit 3\)\. The end of its output:\nexpected 2, got 3\nFull log: .*\nBranch issue-7 is kept; its worktree is removed\.\nreason: gate-failed\n$/,
      reason: "gate-failed",
      worktreeKept: false,
    },
    {
      name: "missing Verdict",
      gate: [{ name: "build", command: "true" }],
      surfaces: UI,
      branch: { "src/ui/panel.ts": "panel\n" },
      stderr: (p) =>
        new RegExp(
          `^verkstad land: #7 did not land: #7 touches the Surface ui, and has no Verdict: there is no ${join(p.dir, ".claude", "verkstad", "verdict-7.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\n` +
            "Branch issue-7 is kept, rebased, in its worktree\\.\nreason: verdict-missing\n$",
        ),
      reason: "verdict-missing",
      worktreeKept: true,
    },
  ];
  for (const s of scenarios) {
    const p = project(t, {
      issues: [claimed(7)],
      contract: contract(s.gate, { ...PR_MODE, ...(s.surfaces ? { surfaces: s.surfaces } : {}) }),
      files: s.files,
    });
    const wt = ticket(p, 7, s.branch);
    if (s.elsewhere) landElsewhere(p, ...s.elsewhere, "Changes it on main");
    const base = originHead(p);

    const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

    assert.equal(r.code, 1, s.name);
    assert.match(r.stderr, s.stderr(p), s.name);
    assert.equal(reason(r.stderr), `reason: ${s.reason}`);
    assert.equal(originHead(p), base, `${s.name}: origin's main is unchanged`);
    assert.equal(originHas(p, "issue-7"), false, `${s.name}: nothing is pushed`);
    assert.equal(existsSync(wt), s.worktreeKept, `${s.name}: the worktree is ${s.worktreeKept ? "kept" : "removed"}`);
    assert.deepEqual(localBranches(p), ["issue-7"], `${s.name}: the branch is kept`);
    assert.deepEqual(p.calls(), [], `${s.name}: no pull request, no issue touched`);
    assert.deepEqual(p.state().pullRequests, []);
    assert.equal(issueOf(p, 7).state, "open");
  }
});

test("in pull-request mode origin refusing the branch fails with push-failed; branch kept, no pull request", (t) => {
  const p = project(t, { issues: [claimed(7)], contract: contract([{ name: "build", command: "true" }], PR_MODE) });
  const hook = join(p.origin, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\necho 'issue branches are protected' >&2\nexit 1\n", { mode: 0o755 });
  const wt = ticket(p, 7, { "feature.txt": "a feature\n" });
  const base = originHead(p);

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.code, 1);
  assert.match(r.stderr, /^verkstad land: #7 did not land: pushing issue-7 to origin failed: .*issue branches are protected/m);
  assert.match(r.stderr, /^Branch issue-7 is kept; its worktree is removed\.\nreason: push-failed\n$/m);
  assert.equal(reason(r.stderr), "reason: push-failed");
  assert.equal(originHead(p), base);
  assert.equal(originHas(p, "issue-7"), false);
  assert.equal(existsSync(wt), false);
  assert.deepEqual(localBranches(p), ["issue-7"]);
  assert.deepEqual(p.calls(), []);
});

test("in pull-request mode, when opening the pull request fails after the push, the Landing still cleans up and exits with github-failed", (t) => {
  const p = project(t, {
    issues: [claimed(7)],
    contract: contract([{ name: "build", command: "true" }], PR_MODE),
    failures: [{ command: "pr create", stderr: "HTTP 502: Bad Gateway" }],
  });
  const wt = ticket(p, 7, { "feature.txt": "a feature\n" });
  const base = originHead(p);

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.code, 1);
  const sha = p.git("--git-dir", p.origin, "rev-parse", "--short", "issue-7");
  assert.equal(
    r.stderr,
    `verkstad land: #7 is on origin as issue-7 at ${sha}, but opening or updating its pull request failed: gh pr create failed: HTTP 502: Bad Gateway\n` +
      'Finish by hand: open a pull request from issue-7 onto main, or update the open one, with "Closes #7.", the report and the Verdict as its body.\n' +
      "reason: github-failed\n",
  );
  assert.equal(originHead(p), base);
  assert.equal(existsSync(wt), false);
  assert.deepEqual(localBranches(p), []);
  assert.deepEqual(p.state().pullRequests, []);
  assert.equal(issueOf(p, 7).state, "open");
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

/** A Gate step that notes each run in the test's temp dir, so that a test sees whether the Gate ran. */
const NOTES_RUN: Step = { name: "test", command: "echo run >> ../gate-runs.txt" };

function gateRuns(p: Project): number {
  const path = join(p.dir, "..", "gate-runs.txt");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).length : 0;
}

function treeOf(p: Project, wt: string): string {
  return p.git("-C", wt, "rev-parse", "HEAD^{tree}");
}

test("after a full Gate passed on the clean branch, a Landing on an unmoved base runs no step, says it reused the pass for that tree, and the closing comment says so", (t) => {
  const p = project(t, { issues: [claimed(7)], contract: contract([{ name: "build", command: "true" }, NOTES_RUN]) });
  const wt = ticket(p, 7, { "feature.txt": "a feature\n" });
  const gate = p.runIn(wt, "gate");
  assert.equal(gate.code, 0, gate.stderr);
  assert.equal(gateRuns(p), 1);
  const tree = treeOf(p, wt);

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.stderr, "");
  assert.equal(r.code, 0);
  assert.equal(gateRuns(p), 1, "no Gate step ran during the Landing");
  const sha = p.git("--git-dir", p.origin, "rev-parse", "--short", "main");
  assert.equal(
    r.stdout,
    `Reused the full Gate pass recorded for tree ${tree}; no step ran.\nLanded #7 on main in ${sha} and closed it.\n`,
  );
  const body =
    `Landed on main in ${sha}.\n\n${REPORT}\n` +
    `The Gate was not run again: a full pass on this tree (${tree}) was recorded before.\n` +
    "Verification state: test-verified. Surfaces: none.\n";
  assert.deepEqual(issueOf(p, 7).comments, [{ author: "owner", body }]);
  assert.equal(originLog(p)[0], "Adds feature.txt. Refs #7");
});

test("when the base moved after the Gate passed, the rebased tree differs and Landing runs the full Gate", (t) => {
  const p = project(t, { issues: [claimed(7)], contract: contract([NOTES_RUN]) });
  const wt = ticket(p, 7, { "feature.txt": "a feature\n" });
  assert.equal(p.runIn(wt, "gate").code, 0);
  landElsewhere(p, "meanwhile.txt", "landed meanwhile\n", "Landed meanwhile");

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.code, 0, r.stderr);
  assert.equal(gateRuns(p), 2, "the Landing ran the Gate");
  assert.match(r.stdout, /^ok {2}test\nGate passed\. Log: /);
  const sha = p.git("--git-dir", p.origin, "rev-parse", "--short", "main");
  assert.equal(r.stdout.split("\n").slice(2).join("\n"), `Landed #7 on main in ${sha} and closed it.\n`);
  const body = `Landed on main in ${sha}.\n\n${REPORT}\nVerification state: test-verified. Surfaces: none.\n`;
  assert.deepEqual(issueOf(p, 7).comments, [{ author: "owner", body }]);
});

test("a change to the Gate's steps committed after the Gate passed changes the tree, so Landing runs the Gate again", (t) => {
  const p = project(t, { issues: [claimed(7)], contract: contract([NOTES_RUN]) });
  const wt = ticket(p, 7, { "feature.txt": "a feature\n" });
  assert.equal(p.runIn(wt, "gate").code, 0);
  const steps = [NOTES_RUN, { name: "build", command: "true" }];
  commit(p, wt, { ".claude/harness.json": `${JSON.stringify(contract(steps), null, 2)}\n` }, "Adds a build step. Refs #7");
  recordReview(p, wt);

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.code, 0, r.stderr);
  assert.equal(gateRuns(p), 2);
  assert.match(r.stdout, /^ok {2}test\nok {2}build\nGate passed\. /);
});

test("a recorded Gate pass older than 30 days is pruned with the rest of the log directory, and Landing then runs the Gate", (t) => {
  const p = project(t, { issues: [claimed(7)], contract: contract([NOTES_RUN]) });
  const wt = ticket(p, 7, { "feature.txt": "a feature\n" });
  assert.equal(p.runIn(wt, "gate").code, 0);
  const record = `gate-pass-${treeOf(p, wt)}.json`;
  age(p, record, 31);

  const pruned = p.run("prune");

  assert.match(pruned.stdout, new RegExp(`^ {2}${record}$`, "m"));
  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(gateRuns(p), 2, "the Landing ran the Gate");
});

test("a pass in which a step changed a tracked file is never reused: the later steps ran on something other than the tree", (t) => {
  const p = project(t, {
    issues: [claimed(7)],
    contract: contract([{ name: "format", command: "[ -e ../reformat ] && echo reformatted > feature.txt; true" }, NOTES_RUN]),
  });
  const wt = ticket(p, 7, { "feature.txt": "a feature\n" });
  writeFileSync(join(p.dir, "..", "reformat"), "");
  assert.equal(p.runIn(wt, "gate").code, 0);
  rmSync(join(p.dir, "..", "reformat"));
  p.git("-C", wt, "checkout", "--", "feature.txt");

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.code, 0, r.stderr);
  assert.equal(gateRuns(p), 2, "the Landing ran the Gate");
  assert.match(r.stdout, /^ok {2}format\nok {2}test\nGate passed\. /);
});

/** Gates a Ticket's worktree in a way that must not be recorded, leaving it as the Ticket's agent would. */
const NOT_RECORDED: Array<[string, (p: Project, wt: string) => void]> = [
  ["a --quick pass", (p, wt) => assert.equal(p.runIn(wt, "gate", "--quick").code, 0)],
  [
    "a failed Gate",
    (p, wt) => {
      writeFileSync(join(p.dir, "..", "red"), "");
      assert.equal(p.runIn(wt, "gate").code, 1);
      rmSync(join(p.dir, "..", "red"));
    },
  ],
  [
    "a pass on a worktree with an untracked file",
    (p, wt) => {
      writeFileSync(join(wt, "scratch.txt"), "not committed\n");
      assert.equal(p.runIn(wt, "gate").code, 0);
      rmSync(join(wt, "scratch.txt"));
    },
  ],
  [
    "a pass on a worktree with an uncommitted change",
    (p, wt) => {
      writeFileSync(join(wt, "feature.txt"), "changed, not committed\n");
      assert.equal(p.runIn(wt, "gate").code, 0);
      p.git("-C", wt, "checkout", "--", "feature.txt");
    },
  ],
];

for (const [what, gateFirst] of NOT_RECORDED) {
  test(`${what} is never reused: Landing runs the full Gate`, (t) => {
    const p = project(t, {
      issues: [claimed(7)],
      contract: contract([{ name: "test", command: "test ! -e ../red && echo run >> ../gate-runs.txt" }]),
    });
    const wt = ticket(p, 7, { "feature.txt": "a feature\n" });
    gateFirst(p, wt);
    const before = gateRuns(p);

    const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

    assert.equal(r.code, 0, r.stderr);
    assert.equal(gateRuns(p), before + 1, "the Landing ran the Gate");
    assert.match(r.stdout, /^ok {2}test\nGate passed\. /);
  });
}

test("a full Gate that skipped an install step by unlessExists is recorded: Landing on an unmoved base runs no step and says it reused the pass", (t) => {
  const p = project(t, {
    issues: [claimed(7)],
    contract: contract([{ name: "install", command: "mkdir node_modules && echo install >> ../gate-runs.txt", unlessExists: "node_modules" }, NOTES_RUN]),
    files: { ".gitignore": ".claude/verkstad/\nnode_modules/\n" },
  });
  const wt = ticket(p, 7, { "feature.txt": "a feature\n" });
  // The agent's quick Gate installs; its full Gate after the last commit skips the install.
  assert.equal(p.runIn(wt, "gate", "--quick").code, 0);
  const full = p.runIn(wt, "gate");
  assert.equal(full.code, 0, full.stderr);
  assert.match(full.stdout, /^ok {2}test\nGate passed\. /);
  assert.equal(gateRuns(p), 3);
  const tree = treeOf(p, wt);

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.stderr, "");
  assert.equal(r.code, 0);
  assert.equal(gateRuns(p), 3, "no Gate step ran during the Landing");
  const sha = p.git("--git-dir", p.origin, "rev-parse", "--short", "main");
  assert.equal(
    r.stdout,
    `Reused the full Gate pass recorded for tree ${tree}; no step ran.\nLanded #7 on main in ${sha} and closed it.\n`,
  );
});

test("a quick Gate that skipped a step by its file filter is not recorded: Landing runs the full Gate", (t) => {
  const p = project(t, {
    issues: [claimed(7)],
    contract: contract([{ ...NOTES_RUN, name: "e2e", quick: { files: "e2e/*.e2e.ts", env: "E2E_FILES" } }]),
  });
  const wt = ticket(p, 7, { "feature.txt": "a feature\n" });
  const quick = p.runIn(wt, "gate", "--quick");
  assert.equal(quick.code, 0, quick.stderr);
  assert.match(quick.stdout, /^-- {2}e2e skipped: no file matching e2e\/\*\.e2e\.ts changed since main\nQuick gate passed\. /);

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.code, 0, r.stderr);
  assert.equal(gateRuns(p), 1, "the Landing ran the Gate");
  assert.match(r.stdout, /^ok {2}e2e\nGate passed\. /);
});

test("in pull-request mode a Landing on an unmoved base reuses a recorded full pass, and the pull request's body says so", (t) => {
  const p = project(t, { issues: [{ ...claimed(7), title: "Show the job's time" }], contract: contract([NOTES_RUN], PR_MODE) });
  const wt = ticket(p, 7, { "feature.txt": "a feature\n" });
  assert.equal(p.runIn(wt, "gate").code, 0);
  const tree = treeOf(p, wt);

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.code, 0, r.stderr);
  assert.equal(gateRuns(p), 1, "no Gate step ran during the Landing");
  assert.match(r.stdout, new RegExp(`^Reused the full Gate pass recorded for tree ${tree}; no step ran\\.\\nOpened `));
  const body =
    `Closes #7.\n\n${REPORT}\n` +
    `The Gate was not run again: a full pass on this tree (${tree}) was recorded before.\n` +
    "Verification state: test-verified. Surfaces: none.\n";
  assert.equal(p.state().pullRequests[0].body, body);
});

/**
 * A branch whose full Gate passed, then a Landing onto a base that moved meanwhile, with the Gate's one step
 * failing while ../red exists. Returns the log of the pass recorded before the rebase.
 */
function passedThenBaseMoved(p: Project, wt: string): string {
  const gate = p.runIn(wt, "gate");
  assert.equal(gate.code, 0, gate.stderr);
  const passLog = /Log: (.*)$/m.exec(gate.stdout)?.[1];
  assert.ok(passLog && existsSync(passLog));
  landElsewhere(p, "meanwhile.txt", "landed meanwhile\n", "Landed meanwhile");
  writeFileSync(join(p.dir, "..", "red"), "");
  return passLog;
}

test("a Gate that fails once on a rebased branch whose tree passed the full Gate before runs once more; the second run passes, the branch lands, and stdout and the comment name the failing step and the first run's log", (t) => {
  const p = project(t, {
    issues: [claimed(7)],
    // Fails once, as a flaky test does: the first failing run removes ../red.
    contract: contract([{ name: "unit tests", command: "if [ -e ../red ]; then rm ../red; echo 'timed out'; exit 3; fi" }]),
  });
  const wt = ticket(p, 7, { "feature.txt": "a feature\n" });
  const passLog = passedThenBaseMoved(p, wt);

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, "");
  const failLog = /^The Gate failed at unit tests \(log: (.*?)\)/.exec(r.stdout)?.[1];
  assert.ok(failLog && failLog !== passLog && existsSync(failLog), r.stdout);
  const secondLog = /^Gate passed\. Log: (.*)$/m.exec(r.stdout)?.[1];
  assert.ok(secondLog && secondLog !== failLog && existsSync(secondLog), r.stdout);
  const sha = p.git("--git-dir", p.origin, "rev-parse", "--short", "main");
  assert.equal(
    r.stdout,
    `The Gate failed at unit tests (log: ${failLog}) on a branch whose tree passed the full Gate before the rebase ` +
      `(log of that pass: ${passLog}); running it once more.\n` +
      "ok  unit tests\n" +
      `Gate passed. Log: ${secondLog}\n` +
      `Landed #7 on main in ${sha} and closed it.\n`,
  );
  const body =
    `Landed on main in ${sha}.\n\n${REPORT}\n` +
    `The first Gate run failed at unit tests (log: ${failLog}); the second passed.\n` +
    "Verification state: test-verified. Surfaces: none.\n";
  assert.deepEqual(issueOf(p, 7).comments, [{ author: "owner", body }]);
  assert.equal(issueOf(p, 7).state, "closed");
  assert.equal(existsSync(wt), false, "the worktree is removed");
});

test("a Gate that fails twice on a rebased branch whose tree passed the full Gate before ends with gate-failed, names both runs' logs and removes the worktree", (t) => {
  const p = project(t, {
    issues: [claimed(7)],
    contract: contract([{ name: "unit tests", command: "echo run >> ../gate-runs.txt; [ -e ../red ] && { echo 'expected 2, got 3'; exit 3; }; true" }]),
  });
  const wt = ticket(p, 7, { "feature.txt": "a feature\n" });
  const passLog = passedThenBaseMoved(p, wt);
  const base = originHead(p);

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.code, 1);
  assert.equal(gateRuns(p), 3, "the Gate passed once before the Landing and ran twice in it");
  const failLog = /^The Gate failed at unit tests \(log: (.*?)\)/.exec(r.stdout)?.[1];
  assert.ok(failLog && failLog !== passLog && existsSync(failLog), r.stdout);
  assert.equal(
    r.stdout,
    `The Gate failed at unit tests (log: ${failLog}) on a branch whose tree passed the full Gate before the rebase ` +
      `(log of that pass: ${passLog}); running it once more.\n`,
  );
  const secondLog = /^Full log: (.*)$/m.exec(r.stderr)?.[1];
  assert.ok(secondLog && secondLog !== failLog && existsSync(secondLog), r.stderr);
  assert.equal(
    r.stderr,
    `verkstad land: #7 did not land: the Gate failed again when run once more (the first run failed at unit tests, log: ${failLog}): ` +
      "unit tests failed (exit 3). The end of its output:\n" +
      "expected 2, got 3\n" +
      `Full log: ${secondLog}\n` +
      "Branch issue-7 is kept; its worktree is removed.\n" +
      "reason: gate-failed\n",
  );
  assert.equal(existsSync(wt), false, "the worktree is removed");
  assert.equal(originHead(p), base);
  assert.equal(issueOf(p, 7).state, "open");
});

test("a Gate that fails on a branch with no full pass recorded ends with gate-failed after one run", (t) => {
  const p = project(t, {
    issues: [claimed(7)],
    contract: contract([{ name: "unit tests", command: "echo run >> ../gate-runs.txt; echo 'expected 2, got 3'; exit 3" }]),
  });
  const wt = ticket(p, 7, { "feature.txt": "a feature\n" });
  landElsewhere(p, "meanwhile.txt", "landed meanwhile\n", "Landed meanwhile");

  const r = p.run("land", "7", wt, tmpFile(p, "report-7.md", REPORT));

  assert.equal(r.code, 1);
  assert.equal(gateRuns(p), 1, "the Gate ran once");
  assert.equal(r.stdout, "");
  const log = /^Full log: (.*)$/m.exec(r.stderr)?.[1];
  assert.ok(log && existsSync(log), r.stderr);
  assert.equal(
    r.stderr,
    "verkstad land: #7 did not land: the Gate failed: unit tests failed (exit 3). The end of its output:\n" +
      "expected 2, got 3\n" +
      `Full log: ${log}\n` +
      "Branch issue-7 is kept; its worktree is removed.\n" +
      "reason: gate-failed\n",
  );
  assert.equal(existsSync(wt), false, "the worktree is removed");
});
