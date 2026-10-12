import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { project } from "./project.ts";

const READY = "ready-for-agent";
const line = (e: object) => JSON.stringify(e) + "\n";

test("release unassigns a Ticket claimed with no Run working it, so the Frontier offers it again", (t) => {
  const p = project(t, { issues: [{ number: 7, title: "Taken", labels: [READY], assignees: ["owner"] }] });

  const r = p.run("release", "7");

  assert.equal(r.stderr, "");
  assert.equal(r.stdout, "Released #7: no longer assigned to @owner, so the Frontier offers it again.\n");
  assert.equal(r.code, 0);
  const seven = p.state().issues.find((i) => i.number === 7)!;
  assert.deepEqual(seven.assignees, []);
  assert.deepEqual(seven.labels, [READY]);
});

test("release takes ready-for-agent off a Spec and leaves its Tickets as they are", (t) => {
  const p = project(t, {
    issues: [
      { number: 1, title: "The Spec", labels: [READY] },
      { number: 2, title: "Its Ticket", labels: [READY], parent: 1 },
    ],
  });

  const r = p.run("release", "1");

  assert.equal(r.stderr, "");
  assert.equal(r.stdout, "Released #1: a Spec, no longer labelled ready-for-agent.\n");
  assert.equal(r.code, 0);
  const labels = (n: number) => p.state().issues.find((i) => i.number === n)!.labels;
  assert.deepEqual(labels(1), []);
  assert.deepEqual(labels(2), [READY]);
});

test("release refuses a Ticket the Run going in the Project works, and changes nothing", (t) => {
  const p = project(t, { issues: [{ number: 7, title: "Taken", labels: [READY], assignees: ["owner"] }] });
  const dir = join(p.dir, ".claude", "verkstad");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "run-2026-10-12T10-00-00-000Z.jsonl"),
    line({ at: "2026-10-12T10:00:00.000Z", run: "started", pid: process.pid, ready: [7] }) +
      line({ at: "2026-10-12T10:00:01.000Z", ticket: 7, claimed: "Taken", tier: "standard" }),
  );

  const r = p.run("release", "7");

  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "verkstad release: #7 is in flight in the Run going; Stop or Abort the Run first\n");
  assert.equal(r.code, 1);
  assert.deepEqual(p.state().issues.find((i) => i.number === 7)!.assignees, ["owner"]);
});

test("release refuses an issue that is neither claimed nor a Spec labelled ready-for-agent", (t) => {
  const p = project(t, {
    issues: [
      { number: 7, title: "Ready", labels: [READY] },
      { number: 8, title: "Untriaged", labels: [] },
    ],
  });

  for (const n of ["7", "8"]) {
    const r = p.run("release", n);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, `verkstad release: #${n} is neither a claimed Ticket nor a Spec labelled ready-for-agent; nothing to release\n`);
    assert.equal(r.code, 1);
  }
  assert.deepEqual(p.state().issues.find((i) => i.number === 7)!.labels, [READY]);
});

test("release takes one issue number", (t) => {
  const p = project(t);

  for (const args of [[], ["seven"], ["7", "8"]]) {
    const r = p.run("release", ...args);
    assert.equal(r.stderr, "verkstad release: usage: verkstad release <n>\n");
    assert.equal(r.code, 2);
  }
});
