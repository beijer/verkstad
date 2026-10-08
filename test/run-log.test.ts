import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { project, type Project } from "./project.ts";

// `verkstad run-log` reads a Run's event log, `run-<time>.jsonl` in the log directory, and each session's
// transcript, which Claude Code keeps in `~/.claude/projects/<the session's cwd, every character but letters
// and digits made ->/<session id>.jsonl`.

type Entry = Record<string, unknown>;

/** A moment of the fixture Run: `min` minutes after 2026-10-01 20:00 UTC. */
function at(min: number): string {
  return new Date(Date.UTC(2026, 9, 1, 20, 0) + min * 60_000).toISOString();
}

function logDir(p: Project): string {
  return join(realpathSync(p.dir), ".claude", "verkstad");
}

/** Writes an event log into the log directory, each event at the minute it names. */
function writeRun(p: Project, name: string, events: Array<[number, Entry]>): string {
  mkdirSync(logDir(p), { recursive: true });
  const file = join(logDir(p), name);
  writeFileSync(file, events.map(([min, e]) => JSON.stringify({ at: at(min), ...e })).join("\n") + "\n");
  return file;
}

function worktree(p: Project, n: number): string {
  return join(realpathSync(p.dir), ".claude", "worktrees", `issue-${n}`);
}

/** The path Claude Code keeps session `id`'s transcript at, when it ran in `cwd`. */
function transcriptPath(p: Project, cwd: string, id: string): string {
  return join(p.env.HOME!, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${id}.jsonl`);
}

/** A transcript whose tool calls returned `results`, each `[text, isError]`. */
function writeTranscript(p: Project, cwd: string, id: string, results: Array<[string, boolean]>): string {
  const path = transcriptPath(p, cwd, id);
  mkdirSync(join(path, ".."), { recursive: true });
  const entries = results.flatMap(([text, isError], i) => [
    { type: "assistant", sessionId: id, message: { id: `m${i}`, role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command: "make" } }] } },
    { type: "user", sessionId: id, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: text, is_error: isError }] } },
  ]);
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return path;
}

const HOOK = "PreToolUse:Bash hook error: verkstad: zsh expands =word at the start of a word; quote it.";
const DENIED = "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Interfere With Workloads].";
const UNGRANTED = "Claude requested permissions to use Bash, but you haven't granted it yet.";
const FAILED = "Exit code 1\nmake: *** [all] Error 1";

/** A Run of two Tickets: #7 Resumed one Tier up, then landed after a conflict; #8 Parked. */
function seedRun(p: Project): string {
  const wt7 = worktree(p, 7);
  const land7 = ["land", "7", wt7, "/tmp/verkstad-run-x/report-7.md"];
  return writeRun(p, "run-2026-10-01T20-00-00-000Z.jsonl", [
    [0, { run: "started", main: realpathSync(p.dir), base: "main", ready: [7, 8] }],
    [0, { ticket: 7, say: "Add a widget: claimed, standard Tier (opus, medium effort, $25 budget)." }],
    [0, { ticket: 7, claimed: "Add a widget", tier: "standard" }],
    [30, { ticket: 7, session: "implementer", id: "s-impl-7", subtype: "error_max_turns", cost: 3.1, turns: 60 }],
    [32, { ticket: 7, session: "implementer", id: "s-impl-7", subtype: "success", cost: 0.4, turns: 5, status: "partial" }],
    [32, { ticket: 7, resumed: "partial: the second screen is not done", tier: "hard" }],
    [60, { ticket: 7, session: "implementer", id: "s-impl-7b", subtype: "success", cost: 6.25, turns: 80, status: "done" }],
    [61, { verkstad: land7, code: 1, stderr: "verkstad land: rebasing issue-7 onto origin/main conflicts in src/a.ts\nreason: conflict\n" }],
    [70, { ticket: 7, session: "conflict finisher", id: "s-conflict-7", subtype: "success", cost: 1.2, turns: 14, status: "done" }],
    [71, { verkstad: land7, code: 0 }],
    [71, { ticket: 7, landed: "landed on main in abc1234", commit: "abc1234" }],
    [72, { ticket: 8, claimed: "Read the sensor", tier: "light" }],
    [80, { ticket: 8, session: "implementer", id: "s-impl-8", subtype: "success", cost: 0.8, turns: 9, status: "blocked" }],
    [81, { verkstad: ["land", "--park", "8", worktree(p, 8), "/tmp/verkstad-run-x/park-8.md"], code: 0 }],
    [81, { ticket: 8, parked: "blocked: needs a USB device\n\nThe implementer's report:\nstatus: blocked" }],
    [81, { run: "finished", sessions: 5, cost: 11.75, finished: [] }],
  ]);
}

test("run-log digests the last Run's event log: per Ticket its Tier, sessions, failed Landings and outcome, each session's failed tool calls by kind, and the Run's totals", (t) => {
  const p = project(t);
  writeRun(p, "run-2026-09-30T10-00-00-000Z.jsonl", [[0, { run: "started" }]]);
  const file = seedRun(p);
  const impl7 = writeTranscript(p, worktree(p, 7), "s-impl-7", [
    ["ok", false],
    [HOOK, true],
    [DENIED, true],
    [UNGRANTED, true],
    [FAILED, true],
    [FAILED, true],
  ]);
  const conflict7 = writeTranscript(p, worktree(p, 7), "s-conflict-7", [["ok", false]]);
  const impl8 = writeTranscript(p, worktree(p, 8), "s-impl-8", [[FAILED, true]]);

  const r = p.run("run-log");

  assert.equal(r.stderr, "");
  assert.equal(
    r.stdout,
    [
      "Run run-2026-10-01T20-00-00-000Z.jsonl, 2026-10-01 20:00 to 21:21 UTC: finished",
      `  Event log: ${file}`,
      "",
      "#7 Add a widget: standard Tier, then hard",
      "  implementer: stopped at its turn limit, $3.10, 60 turns",
      `    ${impl7}: 5 failed tool calls: 1 hook refusal, 2 permission denials, 2 failed commands`,
      "  implementer: ended, $0.40, 5 turns, status partial",
      "    the same session as above",
      "  Resumed on the hard Tier: partial: the second screen is not done",
      "  implementer: ended, $6.25, 80 turns, status done",
      "    transcript gone: no s-impl-7b.jsonl among the Project's sessions",
      "  Landing failed: conflict: rebasing issue-7 onto origin/main conflicts in src/a.ts",
      "  conflict finisher: ended, $1.20, 14 turns, status done",
      `    ${conflict7}: no failed tool calls`,
      "  landed on main in abc1234",
      "",
      "#8 Read the sensor: light Tier",
      "  implementer: ended, $0.80, 9 turns, status blocked",
      `    ${impl8}: 1 failed tool call: 1 failed command`,
      "  parked: blocked: needs a USB device",
      "",
      "Totals: 2 Tickets (1 landed, 1 parked), 5 sessions, $11.75, 168 turns",
      "",
    ].join("\n"),
  );
  assert.equal(r.code, 0);
});

test("run-log --run digests the event log it names, and says how a Run that stopped ended and which Ticket it left", (t) => {
  const p = project(t);
  seedRun(p);
  const older = writeRun(p, "run-2026-09-30T10-00-00-000Z.jsonl", [
    [0, { run: "started", main: realpathSync(p.dir), base: "main", ready: [5] }],
    [0, { ticket: 5, claimed: "Fix the build", tier: "standard" }],
    [9, { ticket: 5, session: "implementer", id: "s-impl-5", subtype: "error_during_execution", cost: 0.05, turns: 1 }],
    [9, { verkstad: ["conflicts", "5", "--rebase", worktree(p, 5)], code: 2, stderr: "verkstad conflicts: no branch issue-5\n" }],
    [9, { run: "stopped", sessions: 1, cost: 0.05, finished: [], error: "#5's implementing session failed (error_during_execution) without a report" }],
  ]);

  const r = p.run("run-log", "--run", older);

  assert.equal(r.stderr, "");
  assert.equal(
    r.stdout,
    [
      "Run run-2026-09-30T10-00-00-000Z.jsonl, 2026-10-01 20:00 to 20:09 UTC: stopped: #5's implementing session failed (error_during_execution) without a report",
      `  Event log: ${older}`,
      "",
      "#5 Fix the build: standard Tier",
      "  implementer: error_during_execution, $0.05, 1 turn",
      "    transcript gone: no s-impl-5.jsonl among the Project's sessions",
      "  verkstad conflicts failed: no branch issue-5",
      "  no outcome: the Run ended before #5 landed or was Parked",
      "",
      "Totals: 1 Ticket (0 landed, 0 parked), 1 session, $0.05, 1 turn",
      "",
    ].join("\n"),
  );
  assert.equal(r.code, 0);
});

test("run-log says a Run that never wrote its last line did not end, with a failed CLI call made on no Ticket, and dates an end on another day", (t) => {
  const p = project(t);
  const file = writeRun(p, "run-2026-10-01T23-50-00-000Z.jsonl", [
    [230, { run: "started", main: realpathSync(p.dir), base: "main", ready: [9] }],
    [231, { verkstad: ["frontier", "--json"], code: 1, stderr: "verkstad frontier: gh failed: HTTP 502\n" }],
    [250, { ticket: 9, claimed: "Ticket 9", tier: "hard" }],
  ]);

  const r = p.run("run-log");

  assert.equal(r.stderr, "");
  assert.equal(
    r.stdout,
    [
      "Run run-2026-10-01T23-50-00-000Z.jsonl, 2026-10-01 23:50 to 2026-10-02 00:10 UTC: did not end (it is still going, or was killed)",
      `  Event log: ${file}`,
      "  verkstad frontier failed: gh failed: HTTP 502",
      "",
      "#9 Ticket 9: hard Tier",
      "  no outcome: the Run ended before #9 landed or was Parked",
      "",
      "Totals: 1 Ticket (0 landed, 0 parked), 0 sessions, $0, 0 turns",
      "",
    ].join("\n"),
  );
  assert.equal(r.code, 0);
});

test("run-log reads the event log verkstad run writes", (t) => {
  const p = project(t, {
    issues: [{ number: 7, title: "Ticket 7", labels: ["ready-for-agent"] }],
    contract: { baseBranch: "main", gate: { steps: [] }, surfaces: [] },
    files: { ".gitignore": ".claude/verkstad/\n.claude/worktrees/\n" },
    sessions: [
      {
        run: ["verkstad start 7", "printf 'built\\n' > a.txt", "git add -A", 'git commit -q -m "Adds a.txt. Refs #7"', "verkstad review record"],
        report: {
          status: "done",
          worktree: "(the worktree)",
          commits: [],
          what_was_built: "The feature.",
          acceptance_criteria: [{ criterion: "It works", verified_by: "a test" }],
          surfaces: [],
          new_surface: "none",
          uncertain: [],
          known_bug: false,
          reviewed: true,
          tier: "ok",
          report: "status: done",
        },
      },
    ],
  });
  assert.equal(p.run("run").code, 0);
  const sha = p.git("--git-dir", p.origin, "rev-parse", "--short", "main");
  const [call] = p.claudeCalls();
  const id = call.args[call.args.indexOf("--session-id") + 1];

  const r = p.run("run-log");

  assert.equal(r.stderr, "");
  assert.match(
    r.stdout,
    new RegExp(
      [
        "^Run run-[0-9TZ-]+\\.jsonl, [0-9-]+ [0-9:]+ to [0-9:]+ UTC: finished",
        "  Event log: .*",
        "",
        "#7 Ticket 7: standard Tier",
        "  implementer: ended, \\$0\\.25, 12 turns, status done",
        `    transcript gone: no ${id}\\.jsonl among the Project's sessions`,
        `  landed on main in ${sha}`,
        "",
        "Totals: 1 Ticket \\(1 landed, 0 parked\\), 1 session, \\$0\\.25, 12 turns",
        "$",
      ].join("\n"),
    ),
  );
  assert.equal(r.code, 0);
});

test("run-log with no event log says there is no Run to digest", (t) => {
  const p = project(t);

  const r = p.run("run-log");

  assert.equal(r.stdout, `No Run to digest: ${logDir(p)} holds no run-*.jsonl.\n`);
  assert.equal(r.stderr, "");
  assert.equal(r.code, 0);
});

test("run-log --run fails on an event log that is not there", (t) => {
  const p = project(t);

  const r = p.run("run-log", "--run", "run-missing.jsonl");

  assert.equal(r.stderr, `verkstad run-log: no event log run-missing.jsonl, here or in ${logDir(p)}\n`);
  assert.equal(r.code, 1);
});

test("run-log refuses an unknown argument, and --run without a value", (t) => {
  const p = project(t);

  const unknown = p.run("run-log", "--session", "abc");
  assert.equal(unknown.stderr, "verkstad run-log: unknown argument '--session'; usage: verkstad run-log [--run <file>]\n");
  assert.equal(unknown.code, 2);

  const bare = p.run("run-log", "--run");
  assert.equal(bare.stderr, "verkstad run-log: --run needs a value; usage: verkstad run-log [--run <file>]\n");
  assert.equal(bare.code, 2);
});
