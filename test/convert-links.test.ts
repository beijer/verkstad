import assert from "node:assert/strict";
import { test } from "node:test";
import { project } from "./project.ts";

/** A Ticket body in Ray's text convention. */
function ticket(parent: string, blockedBy: string): string {
  return `## Parent\n\n${parent}\n\n## What to build\n\nSomething.\n\n## Blocked by\n\n${blockedBy}\n`;
}

/** Ray's open Tickets as they stood: a Spec, Tickets naming it and their blockers in text. */
const ray = {
  repo: "beijer/ray",
  pageSize: 2,
  issues: [
    { number: 1, title: "Spec: the loop", body: "## Problem Statement\n\nA spec.\n" },
    { number: 2, title: "First", body: ticket("#1", "- #3\n- #4"), labels: ["ready-for-agent"] },
    { number: 3, title: "Open blocker", body: ticket("#1", "None - can start immediately.") },
    { number: 4, title: "Closed blocker", body: ticket("#1", "- None"), state: "closed" as const },
    { number: 5, title: "Part of", body: "Part of #1\n\n## Blocked by\n\nBlocked by #3, #4\n" },
    {
      number: 6,
      title: "Talks about headings",
      body: "## What to build\n\nKeep the `## Blocked by #2` heading.\n\n## Blocked by\n\n- None (if #5 lands first, rebase)\n",
    },
  ],
};

test("converts each open Ticket's text parent and blockers into native sub-issue and blocked_by links", (t) => {
  const p = project(t, ray);

  const r = p.run("convert-links");

  assert.equal(r.stderr, "");
  assert.equal(r.code, 0);
  assert.equal(
    r.stdout,
    [
      "#2 sub-issue of #1",
      "#2 blocked by #3",
      "#2 blocked by #4",
      "#3 sub-issue of #1",
      "#5 sub-issue of #1",
      "#5 blocked by #3",
      "#5 blocked by #4",
      "Added 3 sub-issue links and 4 blocked_by links; 0 already there, 0 skipped.",
      "",
    ].join("\n"),
  );
  const issues = Object.fromEntries(p.state().issues.map((i) => [i.number, { parent: i.parent, blockedBy: i.blockedBy }]));
  assert.deepEqual(issues, {
    1: { parent: null, blockedBy: [] },
    2: { parent: 1, blockedBy: [3, 4] },
    3: { parent: 1, blockedBy: [] },
    4: { parent: null, blockedBy: [] },
    5: { parent: 1, blockedBy: [3, 4] },
    6: { parent: null, blockedBy: [] },
  });
  const posts = p.calls().filter((argv) => argv.includes("POST"));
  assert.deepEqual(posts[0], ["api", "repos/beijer/ray/issues/1/sub_issues", "-X", "POST", "-F", "sub_issue_id=1000002"]);
  assert.deepEqual(posts[1], [
    "api",
    "repos/beijer/ray/issues/2/dependencies/blocked_by",
    "-X",
    "POST",
    "-F",
    "issue_id=1000003",
  ]);
  assert.equal(posts.length, 7);
});

test("--dry-run prints the same plan and changes nothing", (t) => {
  const p = project(t, ray);
  const before = p.state();

  const r = p.run("convert-links", "--dry-run");

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^#2 sub-issue of #1\n#2 blocked by #3\n/);
  assert.match(
    r.stdout,
    /\n#5 blocked by #4\nWould add 3 sub-issue links and 4 blocked_by links; 0 already there, 0 skipped\. Nothing changed \(--dry-run\)\.\n$/,
  );
  assert.deepEqual(p.state(), before);
  for (const argv of p.calls()) {
    assert.ok(!argv.includes("POST"), `a dry run made a write: gh ${argv.join(" ")}`);
  }
});

test("run twice, the second run adds nothing", (t) => {
  const p = project(t, ray);
  assert.equal(p.run("convert-links").code, 0);
  const after = p.state();
  const callsBefore = p.calls().length;

  const r = p.run("convert-links");

  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "Added 0 sub-issue links and 0 blocked_by links; 7 already there, 0 skipped.\n");
  assert.deepEqual(p.state(), after);
  const second = p.calls().slice(callsBefore);
  assert.ok(second.length > 0);
  for (const argv of second) assert.ok(!argv.includes("POST"), `gh ${argv.join(" ")}`);
});

test("a reference it can't resolve is reported and skipped, and the rest still converts", (t) => {
  const p = project(t, {
    repo: "beijer/ray",
    issues: [
      { number: 1, title: "Spec" },
      { number: 2, title: "Other Spec" },
      { number: 10, body: ticket("#1", "- #99\n- #7\n- beijer/verkstad#3\n- #10\n- #11") },
      { number: 11, title: "Already elsewhere", body: ticket("#2", "- None"), parent: 1 },
      { number: 12, title: "Spec missing", body: ticket("#98", "- None") },
    ],
    pullRequests: [{ number: 7, title: "A PR", body: "", state: "merged", head: "x", base: "main" }],
  });

  const r = p.run("convert-links");

  assert.equal(r.code, 0, r.stderr);
  assert.equal(
    r.stdout,
    [
      "#10 sub-issue of #1",
      "skipped #10 blocked by #99: beijer/ray has no issue #99",
      "skipped #10 blocked by #7: #7 is a pull request",
      "skipped #10 blocked by beijer/verkstad#3: it is in another repo",
      "skipped #10 blocked by #10: an issue cannot block itself",
      "#10 blocked by #11",
      "skipped #11 sub-issue of #2: it is already a sub-issue of #1",
      "skipped #12 sub-issue of #98: beijer/ray has no issue #98",
      "Added 1 sub-issue link and 1 blocked_by link; 0 already there, 6 skipped.",
      "",
    ].join("\n"),
  );
  const state = p.state();
  assert.equal(state.issues.find((i) => i.number === 11)!.parent, 1, "an existing parent is never moved");
  assert.deepEqual(state.issues.find((i) => i.number === 10)!.blockedBy, [11]);
});

test("closed Tickets are left as they are", (t) => {
  const p = project(t, {
    issues: [
      { number: 1, title: "Spec" },
      { number: 2, title: "Blocker" },
      { number: 3, title: "Done", body: ticket("#1", "- #2"), state: "closed" },
    ],
  });

  const r = p.run("convert-links");

  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "Added 0 sub-issue links and 0 blocked_by links; 0 already there, 0 skipped.\n");
  assert.deepEqual(p.state().issues.find((i) => i.number === 3)!.blockedBy, []);
});

test("when a write fails, convert-links says which link failed and exits non-zero", (t) => {
  const p = project(t, {
    issues: [
      { number: 1, title: "Spec" },
      { number: 2, body: ticket("#1", "- None") },
    ],
    failures: [{ command: "api repos/owner/project/issues/1/sub_issues", stderr: "gh: Resource not accessible by integration (HTTP 403)" }],
  });

  const r = p.run("convert-links");

  assert.equal(r.code, 1);
  assert.equal(
    r.stderr,
    "verkstad convert-links: adding #2 as a sub-issue of #1: gh api repos/owner/project/issues/1/sub_issues failed: gh: Resource not accessible by integration (HTTP 403)\n",
  );
});

test("an unknown argument is a usage error and asks GitHub nothing", (t) => {
  const p = project(t);

  const r = p.run("convert-links", "--dryrun");

  assert.equal(r.code, 2);
  assert.equal(r.stderr, "verkstad convert-links: unknown argument '--dryrun'; usage: verkstad convert-links [--dry-run]\n");
  assert.deepEqual(p.calls(), []);
});
