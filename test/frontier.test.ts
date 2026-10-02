import assert from "node:assert/strict";
import { test } from "node:test";
import { project } from "./project.ts";

const READY = "ready-for-agent";

test("an open, unassigned ready-for-agent Ticket with no blockers is ready", (t) => {
  const p = project(t, {
    repo: "beijer/demo",
    issues: [{ number: 2, title: "Plugin skeleton", labels: [READY] }],
  });

  const r = p.run("frontier");

  assert.equal(r.stderr, "");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, ["Ready (1):", "  #2 Plugin skeleton", "In progress (0):", "Waiting (0):", ""].join("\n"));
});

test("a Ticket is not ready when any one condition fails, and lands where that condition says", (t) => {
  const p = project(t, {
    issues: [
      { number: 1, title: "Blocker", labels: [] },
      { number: 10, title: "Ready", labels: [READY] },
      { number: 11, title: "Closed", labels: [READY], state: "closed" },
      { number: 12, title: "Unlabelled", labels: ["needs-triage"] },
      { number: 13, title: "Assigned", labels: [READY], assignees: ["beijer"] },
      { number: 14, title: "Blocked", labels: [READY], blockedBy: [1] },
    ],
  });

  const r = p.run("frontier");

  assert.equal(r.code, 0, r.stderr);
  assert.equal(
    r.stdout,
    [
      "Ready (1):",
      "  #10 Ready",
      "In progress (1):",
      "  #13 Assigned  (@beijer)",
      "Waiting (1):",
      "  #14 Blocked  <- #1",
      "",
    ].join("\n"),
  );
});

test("a Ticket with one closed and one open blocker is waiting, and the view names only the open one", (t) => {
  const p = project(t, {
    issues: [
      { number: 3, title: "Done already", state: "closed", labels: [READY] },
      { number: 4, title: "Still open", labels: [READY], assignees: ["beijer"] },
      { number: 5, title: "Builds on both", labels: [READY], blockedBy: [3, 4] },
    ],
  });

  const r = p.run("frontier");

  assert.equal(r.code, 0, r.stderr);
  assert.equal(
    r.stdout,
    [
      "Ready (0):",
      "In progress (1):",
      "  #4 Still open  (@beijer)",
      "Waiting (1):",
      "  #5 Builds on both  <- #4",
      "",
    ].join("\n"),
  );
});

test("a Spec with sub-issues is never ready, even labelled ready-for-agent, and is flagged", (t) => {
  const p = project(t, {
    issues: [
      { number: 1, title: "Spec: the loop", labels: [READY] },
      { number: 2, title: "First Ticket", labels: [READY], parent: 1 },
      { number: 6, title: "Unlabelled Spec", labels: [] },
      { number: 7, title: "Its Ticket", labels: [], parent: 6 },
    ],
  });

  const r = p.run("frontier");

  assert.equal(r.code, 0, r.stderr);
  assert.equal(
    r.stdout,
    [
      "Ready (1):",
      "  #2 First Ticket",
      "In progress (0):",
      "Waiting (0):",
      "Specs wrongly labelled ready-for-agent: #1",
      "",
    ].join("\n"),
  );
});

test("a waiting Ticket shows which of its blockers wait on the owner", (t) => {
  const p = project(t, {
    issues: [
      { number: 20, title: "Needs a human", labels: ["ready-for-human"] },
      { number: 21, title: "Needs info", labels: ["needs-info"] },
      { number: 22, title: "Agent work", labels: [READY], assignees: ["beijer"] },
      { number: 23, title: "Behind all three", labels: [READY], blockedBy: [22, 21, 20] },
    ],
  });

  const r = p.run("frontier");

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^ {2}#23 Behind all three {2}<- #20 \[human\], #21 \[needs-info\], #22$/m);
});

test("--json prints the same lists as data", (t) => {
  const p = project(t, {
    issues: [
      { number: 1, title: "Spec", labels: [READY] },
      { number: 2, title: "Ready one", labels: [READY, "tier:light"], parent: 1 },
      { number: 3, title: "Taken", labels: [READY], assignees: ["beijer"], parent: 1 },
      { number: 4, title: "Blocked one", labels: [READY], blockedBy: [3], parent: 1 },
      { number: 5, title: "Closed blocker", state: "closed" },
      { number: 6, title: "Unblocked one", labels: [READY], blockedBy: [5] },
    ],
  });

  const r = p.run("frontier", "--json");

  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    ready: [
      { number: 2, title: "Ready one", labels: [READY, "tier:light"], assignees: [], open_blockers: [] },
      { number: 6, title: "Unblocked one", labels: [READY], assignees: [], open_blockers: [] },
    ],
    in_progress: [{ number: 3, title: "Taken", labels: [READY], assignees: ["beijer"], open_blockers: [] }],
    waiting: [
      {
        number: 4,
        title: "Blocked one",
        labels: [READY],
        assignees: [],
        open_blockers: [{ number: 3, title: "Taken", labels: [READY] }],
      },
    ],
    specs_labelled: [{ number: 1, title: "Spec", labels: [READY], assignees: [], open_blockers: [] }],
  });
});

test("the Frontier reads every page of issues GitHub returns, asking only read-only queries", (t) => {
  const p = project(t, {
    repo: "beijer/demo",
    pageSize: 2,
    issues: [
      { number: 7, title: "Seven", labels: [READY] },
      { number: 8, title: "Eight", labels: [READY] },
      { number: 9, title: "Nine", labels: [READY] },
    ],
  });

  const r = p.run("frontier");

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Ready \(3\):\n {2}#7 Seven\n {2}#8 Eight\n {2}#9 Nine\n/);
  const calls = p.calls();
  assert.deepEqual(calls[0], ["repo", "view", "--json", "nameWithOwner"]);
  assert.deepEqual(
    calls.slice(1).map((argv) => argv.slice(0, 2)),
    [["api", "graphql"], ["api", "graphql"]],
  );
  for (const argv of calls.slice(1)) {
    assert.ok(argv.includes("owner=beijer") && argv.includes("name=demo"), argv.join(" "));
    assert.match(argv.find((a) => a.startsWith("query="))!, /^query=query Frontier\(/);
  }
  assert.ok(calls[2].includes("after=2"), "the second page starts after the first");
});

test("when gh fails, frontier says what failed and exits non-zero", (t) => {
  const p = project(t, {
    issues: [{ number: 2, title: "Ready", labels: [READY] }],
    failures: [{ command: "api graphql", stderr: "HTTP 502: Bad Gateway" }],
  });

  const r = p.run("frontier");

  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "verkstad frontier: gh api graphql failed: HTTP 502: Bad Gateway\n");
});

test("an unknown argument is a usage error and asks GitHub nothing", (t) => {
  const p = project(t);

  const r = p.run("frontier", "--jsn");

  assert.equal(r.code, 2);
  assert.equal(r.stderr, "verkstad frontier: unknown argument '--jsn'; usage: verkstad frontier [--json]\n");
  assert.deepEqual(p.calls(), []);
});
