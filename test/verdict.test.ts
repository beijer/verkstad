import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { project, type Project } from "./project.ts";

const UI = [{ name: "ui", globs: ["src/ui/**"] }];
const CRITERIA = [
  { criterion: "The panel shows the job's time", seen: "Opened the panel: it read 3 min 12 s." },
  { criterion: "Export saves an SVG", seen: "Clicked Export; out.svg opened in a viewer\nwith both layers." },
];

function contract(surfaces: unknown = UI): object {
  return { baseBranch: "main", gate: { steps: [{ name: "build", command: "true" }] }, surfaces };
}

function tmpFile(p: Project, name: string, content: string): string {
  const path = join(p.dir, "..", name);
  writeFileSync(path, content);
  return path;
}

/** A Ticket's worktree: branch issue-<n> off main, one commit per file set. */
function ticket(p: Project, n: number, ...commits: Array<Record<string, string>>): string {
  const wt = join(p.dir, "..", `wt-${n}`);
  p.git("worktree", "add", "--quiet", "-b", `issue-${n}`, wt, "main");
  for (const files of commits) addCommit(p, wt, files);
  return wt;
}

function addCommit(p: Project, wt: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(wt, path)), { recursive: true });
    writeFileSync(join(wt, path), content);
    p.git("-C", wt, "add", path);
  }
  p.git("-C", wt, "commit", "--quiet", "-m", `Adds ${Object.keys(files).join(", ")}`);
}

/** The patch-id the docs say a Verdict holds, computed here the way docs/verdict.md spells it out. */
function expectedPatchId(p: Project, wt: string): string {
  const r = spawnSync("bash", ["-c", "git diff $(git merge-base origin/main HEAD) HEAD | git patch-id --stable"], {
    cwd: wt,
    env: p.env,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split(" ")[0];
}

function logDir(p: Project): string {
  return join(p.dir, ".claude", "verkstad");
}

function readVerdict(p: Project, n: number): Record<string, unknown> {
  return JSON.parse(readFileSync(join(logDir(p), `verdict-${n}.json`), "utf8"));
}

function record(p: Project, n: number, wt: string, state: string): void {
  const criteria = tmpFile(p, `criteria-${n}.json`, JSON.stringify(CRITERIA));
  const r = p.run("verdict", "record", String(n), wt, "--state", state, "--criteria", criteria);
  assert.equal(r.code, 0, r.stderr);
}

test("verdict record writes the Verdict for the branch's patch, with the criteria and an Evidence directory", (t) => {
  const p = project(t, { contract: contract() });
  const wt = ticket(p, 7, { "src/ui/panel.ts": "panel\n" }, { "src/core/time.ts": "time\n" });
  const criteria = tmpFile(p, "criteria-7.json", JSON.stringify(CRITERIA));
  const before = Date.now();

  const r = p.runIn(wt, "verdict", "record", "7", wt, "--state", "live-verified", "--criteria", criteria);

  assert.equal(r.stderr, "");
  assert.equal(r.code, 0);
  const patchId = expectedPatchId(p, wt);
  const path = join(logDir(p), "verdict-7.json");
  assert.equal(r.stdout, `Recorded #7's Verdict: live-verified for patch ${patchId.slice(0, 12)}, 2 criteria, in ${path}\n`);
  const verdict = readVerdict(p, 7);
  const recordedAt = Date.parse(verdict.recordedAt as string);
  assert.ok(recordedAt >= before - 1000 && recordedAt <= Date.now(), `recordedAt ${verdict.recordedAt} is now`);
  assert.deepEqual(verdict, {
    ticket: 7,
    state: "live-verified",
    patchId,
    criteria: CRITERIA,
    evidence: join(logDir(p), "evidence-7"),
    recordedAt: verdict.recordedAt,
  });
  assert.ok(statSync(join(logDir(p), "evidence-7")).isDirectory());
  assert.equal(p.git("-C", wt, "status", "--porcelain"), "", "nothing is written in the worktree");
  assert.deepEqual(p.calls(), []);
});

test("verdict record refuses a bad call and a worktree whose patch is not what was Walked, writing nothing", (t) => {
  const p = project(t, { contract: contract() });
  const wt = ticket(p, 7, { "src/ui/panel.ts": "panel\n" });
  const empty = ticket(p, 8);
  const criteria = tmpFile(p, "criteria.json", JSON.stringify(CRITERIA));
  const args = (n: string, at: string, state = "live-verified", file = criteria) => ["verdict", "record", n, at, "--state", state, "--criteria", file];

  const cases: Array<[string[], number, string]> = [
    [["verdict", "record", "7", wt, "--state", "live-verified"], 2, "usage: verkstad verdict record <n> <worktree> --state <state> --criteria <file>"],
    [args("7", wt, "verified"), 2, "--state must be one of live-verified, test-verified, blocked, failed, not 'verified'"],
    [args("7", empty), 1, `${empty} is on branch issue-8, not issue-7`],
    [args("7", wt, "live-verified", tmpFile(p, "none.json", "[]")), 1, `the criteria file ${join(p.dir, "..", "none.json")}: criteria must be a non-empty array`],
    [
      args("7", wt, "live-verified", tmpFile(p, "unseen.json", JSON.stringify([{ criterion: "It works" }]))),
      1,
      `the criteria file ${join(p.dir, "..", "unseen.json")}: criteria[0] must be an object with a non-empty criterion and seen`,
    ],
    [args("8", empty), 1, `issue-8 has no changes since it left origin/main, so there is no patch to give a Verdict for`],
  ];
  for (const [call, code, why] of cases) {
    const r = p.run(...call);
    assert.equal(r.code, code, `${call.join(" ")}: ${r.stderr}`);
    assert.equal(r.stderr.split("\n")[0], `verkstad verdict: ${why.split("\n")[0]}`);
  }
  writeFileSync(join(wt, "src", "ui", "panel.ts"), "edited by hand\n");
  const dirty = p.run(...args("7", wt));
  assert.equal(dirty.code, 1);
  assert.equal(
    dirty.stderr,
    `verkstad verdict: ${wt} has uncommitted changes, so what was Walked is not the branch's patch; commit or discard them\n`,
  );
  assert.equal(existsSync(join(logDir(p), "verdict-7.json")), false);
  assert.equal(existsSync(join(logDir(p), "verdict-8.json")), false);
});

test("verdict check passes a Ticket that touches no Surface, with or without a Verdict, whatever its state", (t) => {
  const p = project(t, { contract: contract() });
  const wt = ticket(p, 7, { "src/core/time.ts": "time\n" });

  const without = p.run("verdict", "check", "7", wt);
  assert.equal(without.stderr, "");
  assert.equal(without.code, 0);
  assert.equal(without.stdout, "#7 touches no Surface, so it needs no Verdict.\n");

  record(p, 7, wt, "failed");
  const withFailed = p.run("verdict", "check", "7", wt);
  assert.equal(withFailed.code, 0, withFailed.stderr);
  assert.equal(withFailed.stdout, "#7 touches no Surface, so it needs no Verdict.\n");
});

test("verdict check passes a Ticket touching a Surface only with a live-verified Verdict for its patch", (t) => {
  const p = project(t, { contract: contract([...UI, { name: "api", globs: ["src/api/**"] }]) });
  const wt = ticket(p, 7, { "src/ui/panel.ts": "panel\n", "src/api/time.ts": "time\n" });
  const path = join(logDir(p), "verdict-7.json");

  const missing = p.run("verdict", "check", "7", wt);
  assert.equal(missing.code, 1);
  assert.equal(missing.stdout, "");
  assert.equal(
    missing.stderr,
    `verkstad verdict: #7 touches the Surfaces ui, api, and has no Verdict: there is no ${path}.\nreason: verdict-missing\n`,
  );

  for (const state of ["test-verified", "blocked", "failed"]) {
    record(p, 7, wt, state);
    const r = p.run("verdict", "check", "7", wt);
    assert.equal(r.code, 1, state);
    assert.equal(
      r.stderr,
      `verkstad verdict: #7 touches the Surfaces ui, api, and its Verdict is ${state}, not live-verified.\nreason: verdict-not-live\n`,
    );
  }

  record(p, 7, wt, "live-verified");
  const live = p.run("verdict", "check", "7", wt);
  assert.equal(live.stderr, "");
  assert.equal(live.code, 0);
  assert.equal(live.stdout, "#7 touches the Surfaces ui, api; its Verdict is live-verified for this patch.\n");

  // A new commit, as a Fix round makes, changes the patch: the Verdict no longer holds.
  const given = expectedPatchId(p, wt);
  addCommit(p, wt, { "src/ui/panel.ts": "panel, fixed\n" });
  const now = expectedPatchId(p, wt);
  const void_ = p.run("verdict", "check", "7", wt);
  assert.equal(void_.code, 1);
  assert.equal(
    void_.stderr,
    `verkstad verdict: #7 touches the Surfaces ui, api, and its Verdict is void: it was given for patch ${given.slice(0, 12)}, ` +
      `but the branch is now patch ${now.slice(0, 12)}. The changed patch needs a new Verdict.\nreason: verdict-void\n`,
  );
});

test("verdict check counts a malformed Verdict as missing", (t) => {
  const p = project(t, { contract: contract() });
  const wt = ticket(p, 7, { "src/ui/panel.ts": "panel\n" });
  record(p, 7, wt, "live-verified");
  const path = join(logDir(p), "verdict-7.json");
  writeFileSync(path, JSON.stringify({ ...readVerdict(p, 7), ticket: 8 }));

  const r = p.run("verdict", "check", "7", wt);

  assert.equal(r.code, 1);
  assert.equal(r.stderr, `verkstad verdict: #7 touches the Surface ui, and its Verdict ${path} is not one: its ticket is 8, not 7.\nreason: verdict-missing\n`);
});

test("verdict evidence creates and prints the Ticket's Evidence directory in the log directory", (t) => {
  const p = project(t, { contract: contract() });
  const wt = ticket(p, 7, { "src/ui/panel.ts": "panel\n" });

  const r = p.runIn(join(wt, "src"), "verdict", "evidence", "7");

  assert.equal(r.stderr, "");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, `${join(logDir(p), "evidence-7")}\n`);
  assert.ok(statSync(join(logDir(p), "evidence-7")).isDirectory());
});
