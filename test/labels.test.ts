import assert from "node:assert/strict";
import { test } from "node:test";
import { project } from "./project.ts";

/** The labels GitHub gives a new repo, among them `wontfix`. */
const githubDefaults = [
  { name: "bug", description: "Something isn't working", color: "d73a4a" },
  { name: "question", description: "Further information is requested", color: "d876e3" },
  { name: "wontfix", description: "This will not be worked on", color: "ffffff" },
];

test("creates the triage labels a new repo lacks and leaves the one GitHub already gave it", (t) => {
  const p = project(t, { labels: githubDefaults });

  const r = p.run("labels");

  assert.equal(r.stderr, "");
  assert.equal(r.code, 0);
  assert.equal(
    r.stdout,
    [
      "needs-triage     created",
      "needs-info       created",
      "ready-for-agent  created",
      "ready-for-human  created",
      "wontfix          exists",
      "",
    ].join("\n"),
  );
  assert.deepEqual(p.state().labels, [
    ...githubDefaults,
    { name: "needs-triage", description: "Maintainer needs to evaluate this issue", color: "fbca04" },
    { name: "needs-info", description: "Waiting on reporter for more information", color: "d876e3" },
    { name: "ready-for-agent", description: "Fully specified, ready for an AFK agent", color: "0e8a16" },
    { name: "ready-for-human", description: "Requires human implementation", color: "1d76db" },
  ]);
});

test("a Project that has every triage label gets nothing created, whatever case GitHub keeps them in", (t) => {
  const labels = [
    { name: "Needs-Triage", description: "", color: "000000" },
    { name: "needs-info", description: "Ours", color: "111111" },
    { name: "ready-for-agent", description: "", color: "222222" },
    { name: "ready-for-human", description: "", color: "333333" },
    { name: "wontfix", description: "", color: "444444" },
  ];
  const p = project(t, { labels });

  const r = p.run("labels");

  assert.equal(r.code, 0, r.stderr);
  assert.equal(
    r.stdout,
    [
      "needs-triage     exists as Needs-Triage",
      "needs-info       exists",
      "ready-for-agent  exists",
      "ready-for-human  exists",
      "wontfix          exists",
      "",
    ].join("\n"),
  );
  assert.deepEqual(p.state().labels, labels);
  assert.deepEqual(p.calls(), [["label", "list", "--json", "name", "--limit", "1000"]]);
});

test("--dry-run says which labels it would create and creates none", (t) => {
  const p = project(t, { labels: githubDefaults });

  const r = p.run("labels", "--dry-run");

  assert.equal(r.code, 0, r.stderr);
  assert.equal(
    r.stdout,
    [
      "needs-triage     would create",
      "needs-info       would create",
      "ready-for-agent  would create",
      "ready-for-human  would create",
      "wontfix          exists",
      "",
    ].join("\n"),
  );
  assert.deepEqual(p.state().labels, githubDefaults);
  assert.deepEqual(p.calls(), [["label", "list", "--json", "name", "--limit", "1000"]]);
});

test("a label GitHub refuses to create is named, and the others are still created", (t) => {
  const p = project(t, {
    labels: githubDefaults,
    failures: [{ command: "label create ready-for-agent", stderr: "HTTP 403: Resource not accessible by integration" }],
  });

  const r = p.run("labels");

  assert.equal(r.code, 1);
  assert.equal(
    r.stdout,
    [
      "needs-triage     created",
      "needs-info       created",
      "ready-for-agent  failed",
      "ready-for-human  created",
      "wontfix          exists",
      "",
    ].join("\n"),
  );
  assert.equal(
    r.stderr,
    "verkstad labels: could not create ready-for-agent: gh label create failed: HTTP 403: Resource not accessible by integration\n",
  );
  assert.deepEqual(
    p.state().labels.map((l) => l.name),
    ["bug", "question", "wontfix", "needs-triage", "needs-info", "ready-for-human"],
  );
});

test("an unknown option is a usage error that touches nothing", (t) => {
  const p = project(t, { labels: githubDefaults });

  const r = p.run("labels", "--force");

  assert.equal(r.code, 2);
  assert.equal(r.stderr, "verkstad labels: unknown option '--force'; usage: verkstad labels [--dry-run]\n");
  assert.deepEqual(p.calls(), []);
});
