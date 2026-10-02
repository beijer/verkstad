import assert from "node:assert/strict";
import { mkdirSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { project, type Project } from "./project.ts";

// Claude Code's transcripts, as `verkstad run-log` reads them: one JSONL file per session in
// `~/.claude/projects/<the session's cwd, every character but letters and digits made ->/`, and
// each subagent's transcript, with a `.meta.json` beside it, in `<session>/subagents/`.

/** A moment of the fixture Run: `min` minutes after 2026-10-01 20:00 UTC. */
function at(min: number): string {
  return new Date(Date.UTC(2026, 9, 1, 20, 0) + min * 60_000).toISOString();
}

type Entry = Record<string, unknown>;

const ORCHESTRATE = "<command-message>verkstad:orchestrate</command-message>\n<command-name>/verkstad:orchestrate</command-name>";

function prompt(min: number, text: string, kind = "human"): Entry {
  return { type: "user", isSidechain: false, timestamp: at(min), origin: { kind }, message: { role: "user", content: text } };
}

function notification(min: number, taskId: string, status: string): Entry {
  const text = `<task-notification>\n<task-id>${taskId}</task-id>\n<status>${status}</status>\n<summary>Agent finished</summary>\n</task-notification>`;
  return prompt(min, text, "task-notification");
}

function usage(context: number): Entry {
  return { input_tokens: 2, cache_read_input_tokens: context, cache_creation_input_tokens: 0, output_tokens: 40 };
}

/** One content block of assistant message `msg`; a message with several blocks takes several entries. */
function assistant(min: number, msg: string, block: Entry, context = 1000): Entry {
  return { type: "assistant", timestamp: at(min), message: { id: msg, role: "assistant", content: [block], usage: usage(context) } };
}

function call(min: number, msg: string, id: string, name: string, input: Entry, context?: number): Entry {
  return assistant(min, msg, { type: "tool_use", id, name, input }, context);
}

function say(min: number, msg: string, text: string, context?: number): Entry {
  return assistant(min, msg, { type: "text", text }, context);
}

function result(min: number, id: string, text: string, isError = false): Entry {
  return {
    type: "user",
    timestamp: at(min),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: isError }] },
  };
}

interface Agent {
  id: string;
  meta: Entry;
  entries: Entry[];
}

/** The project directory Claude Code keeps the sessions run in `cwd` in, under the test's HOME. */
function sessionDir(p: Project, cwd = realpathSync(p.dir)): string {
  return join(p.env.HOME!, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
}

function writeSession(p: Project, id: string, entries: Entry[], agents: Agent[] = [], dir = sessionDir(p)): void {
  mkdirSync(dir, { recursive: true });
  const jsonl = (es: Entry[]) => es.map((e) => JSON.stringify({ sessionId: id, ...e })).join("\n") + "\n";
  writeFileSync(join(dir, `${id}.jsonl`), jsonl(entries));
  if (!agents.length) return;
  const sub = join(dir, id, "subagents");
  mkdirSync(sub, { recursive: true });
  for (const a of agents) {
    writeFileSync(join(sub, `agent-${a.id}.jsonl`), jsonl(a.entries.map((e) => ({ isSidechain: true, agentId: a.id, ...e }))));
    writeFileSync(join(sub, `agent-${a.id}.meta.json`), JSON.stringify(a.meta));
  }
}

/** A file in the log directory, last written at `min`. */
function logFile(p: Project, name: string, content: string, min: number): void {
  const dir = join(p.dir, ".claude", "verkstad");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content);
  const when = new Date(at(min));
  utimesSync(join(dir, name), when, when);
}

const ISOLATED =
  "This agent is isolated in the worktree /p/.claude/worktrees/agent-a1, but this command is too complex to verify that it stays inside the worktree. Refusing to run it.";
const DENIED = "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Interfere With Workloads].";

/** A Run with two implementers (one Resumed after a red Gate at Landing, one Parked) and a nested reviewer. */
function seedRun(p: Project): void {
  const failedLog = join(realpathSync(p.dir), ".claude", "verkstad", "gate-agent-a1-20261001-214400.log");
  writeSession(p, "old-run", [prompt(0, ORCHESTRATE), say(1, "m0", "Nothing is ready.")]);

  const agents: Agent[] = [
    {
      id: "a1",
      meta: { agentType: "ticket-standard", description: "Ticket #7 import", spawnDepth: 1 },
      entries: [
        prompt(101, "You are implementing Ticket #7 of owner/project."),
        say(102, "m1", "Reading the Ticket.", 30_000),
        call(102, "m1", "t1", "Bash", { command: "git -C /elsewhere status\ngit log" }, 30_000),
        result(103, "t1", ISOLATED, true),
        call(104, "m2", "t2", "Bash", { command: "verkstad gate --quick" }, 40_600),
        result(110, "t2", `ok  typecheck\nverkstad gate: unit tests failed (exit 1). The end of its output:\nexpected 2\nFull log: ${failedLog}`, true),
        call(111, "m3", "t3", "SubagentHandback", { message: "status: done\nworktree: /p/.claude/worktrees/agent-a1\ntier: too low" }, 41_000),
        say(112, "m4", "I've handed my report back.", 41_000),
      ],
    },
    {
      id: "a3",
      meta: { agentType: "general-purpose", description: "Standards review of #7", parentAgentId: "a1", spawnDepth: 2 },
      entries: [prompt(105, "Review the diff."), say(106, "m1", "No findings.", 12_000)],
    },
    {
      id: "a2",
      meta: { agentType: "ticket-light", description: "Ticket #9 export", spawnDepth: 1 },
      entries: [
        prompt(101, "You are implementing Ticket #9 of owner/project."),
        call(102, "m1", "t1", "Bash", { command: "cd /p && git status" }, 20_000),
        result(102, "t1", ISOLATED.replaceAll("a1", "a2"), true),
        call(103, "m2", "t2", "Bash", { command: "kill 4242" }, 21_000),
        result(103, "t2", DENIED, true),
        call(104, "m3", "t3", "Bash", { command: "cd /p/wt && npm test -- export" }, 22_000),
        result(104, "t3", "Exit code 1\n1 failing", true),
        say(105, "m4", "status: blocked\nUncertain: the file name.\ntier: ok", 23_000),
      ],
    },
  ];
  writeSession(
    p,
    "new-run",
    [
      prompt(100, ORCHESTRATE),
      { type: "user", isSidechain: false, isMeta: true, timestamp: at(100), message: { role: "user", content: "Base directory for this skill" } },
      call(100, "m1", "o1", "Bash", { command: "verkstad frontier" }),
      result(100, "o1", "ready: #7 #9"),
      prompt(101, "yes, go"),
      call(101, "m2", "o2", "Agent", { description: "Ticket #7 import", subagent_type: "verkstad:ticket-standard", prompt: "You are implementing Ticket #7" }),
      call(101, "m2", "o3", "Agent", { description: "Ticket #9 export", subagent_type: "verkstad:ticket-light", prompt: "You are implementing Ticket #9" }),
      notification(112, "a1", "completed"),
      call(113, "m3", "o4", "Bash", { command: "verkstad land 7 /p/.claude/worktrees/agent-a1 /p/.claude/verkstad/report-7.md" }),
      result(120, "o4", "ok  typecheck\nverkstad land: the Gate failed\nreason: gate-failed", true),
      call(121, "m4", "o5", "Agent", { description: "Resume #7 red gate", subagent_type: "verkstad:ticket-standard", prompt: "Resume: …" }),
      notification(122, "a2", "completed"),
      call(123, "m5", "o6", "Bash", { command: "verkstad land --park 9 /p/.claude/worktrees/agent-a2 /p/.claude/verkstad/park-9.md" }),
      result(124, "o6", "Parked #9."),
      call(125, "m6", "o7", "Bash", { command: "verkstad land 7 /p/.claude/worktrees/agent-a4 /p/.claude/verkstad/report-7.md" }),
      result(130, "o7", "Landed #7 on main in abc1234 and closed it."),
      prompt(131, "next time, two at a time"),
      say(131, "m7", "Run finished."),
    ],
    agents,
  );
  writeSession(p, "chat", [prompt(200, "what does verkstad:orchestrate do?"), say(201, "m1", "It runs the Frontier.")]);

  logFile(p, "report-3.md", "status: done\ntier: ok\n", 1);
  logFile(p, "report-7.md", "status: done\nworktree: /p/.claude/worktrees/agent-a4\n**tier:** too low\n", 121);
  logFile(p, "verifier-9.md", "verdict: failed\nworktree: /p/.claude/worktrees/agent-a2\n", 122);
  logFile(p, "park-9.md", "\nThe export needs a decision on the file name.\nMore detail.\n", 123);
  logFile(
    p,
    "verdict-9.json",
    JSON.stringify({
      ticket: 9,
      state: "failed",
      criteria: [
        { criterion: "Export opens a dialog", seen: "It opened." },
        { criterion: "Export saves an SVG", seen: "Clicked Export; nothing was saved." },
      ],
    }),
    122,
  );
  logFile(p, "verdict-4.json", JSON.stringify({ ticket: 4, state: "live-verified", criteria: [] }), 126);
  logFile(p, "gate-agent-a1-20261001-214400.log", "== typecheck\n", 110);
  logFile(p, "gate-agent-a4-20261001-220500.log", "== typecheck\n", 128);
  logFile(p, "gate-agent-a0-20261001-200000.log", "== typecheck\n", 2);
}

test("run-log digests the last session that invoked verkstad:orchestrate: its owner prompts, agents, tool errors and log files", (t) => {
  const p = project(t);
  seedRun(p);
  const sessions = sessionDir(p);
  const log = join(realpathSync(p.dir), ".claude", "verkstad");

  const r = p.run("run-log");

  assert.equal(r.stderr, "");
  assert.equal(r.code, 0);
  assert.equal(
    r.stdout,
    [
      "Run new-run, invoked as /verkstad:orchestrate, from 2026-10-01 21:40 to 2026-10-01 22:11 UTC",
      `  Transcript: ${sessions}/new-run.jsonl`,
      `  Agents' transcripts: ${sessions}/new-run/subagents/`,
      `  Log directory: ${log}`,
      "",
      "Owner prompts (2):",
      "  2026-10-01 21:41  yes, go",
      "  2026-10-01 22:11  next time, two at a time",
      "",
      "Orchestrator: 7 turns, 1 error",
      "  Dispatched: 3 agents; more than once: #7 (2)",
      "  Landings: 2; failed: #7 gate-failed (new-run.jsonl:10); Parked: #9",
      "",
      "Agents (3):",
      '  a1  ticket-standard  #7  4 turns, context 41k, gate 1 (1 failed), 2 errors  status done, tier too low  "Ticket #7 import"',
      '  a2  ticket-light  #9  4 turns, context 23k, 3 errors (1 denied)  status blocked, tier ok  "Ticket #9 export"',
      '  a3  general-purpose  #7  1 turn, context 12k, under a1  "Standards review of #7"',
      "",
      "Tool errors (6), by kind:",
      "  2x in 2 agents: This agent is isolated in the worktree <path>, but this command is too complex to verify that it stays inside the workt…",
      "    agent-a1.jsonl:4  git -C /elsewhere status",
      "    agent-a2.jsonl:3  cd /p && git status",
      "  1x: Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Interfere With Workloads].",
      "    agent-a2.jsonl:5  kill 4242",
      "  1x: exit N from npm",
      "    agent-a2.jsonl:7  cd /p/wt && npm test -- export",
      "  1x: verkstad gate: unit tests failed (exit N). The end of its output:",
      "    agent-a1.jsonl:6  verkstad gate --quick",
      "  1x: verkstad land: the Gate failed",
      "    new-run.jsonl:10  verkstad land 7 /p/.claude/worktrees/agent-a1 /p/.claude/verkstad/report-7.md",
      "",
      "Log directory, written during the Run (7 entries):",
      "  report-7.md  status done, tier too low",
      "  verifier-9.md  verdict failed",
      "  park-9.md  The export needs a decision on the file name.",
      "  verdict-4.json  live-verified",
      "  verdict-9.json  failed",
      "    Export opens a dialog: It opened.",
      "    Export saves an SVG: Clicked Export; nothing was saved.",
      "  gate logs: 2; failed: gate-agent-a1-20261001-214400.log",
      "",
    ].join("\n"),
  );
});

test("run-log --session digests the session the owner names, even one that never invoked verkstad:orchestrate", (t) => {
  const p = project(t);
  seedRun(p);
  writeSession(p, "legacy-1234", [
    prompt(300, "run the open Tickets"),
    prompt(300, "<command-message>orchestrate-issues</command-message>\n<command-name>/orchestrate-issues</command-name>"),
    prompt(301, "go ahead"),
    say(302, "m1", "Done."),
  ]);

  const r = p.run("run-log", "--session", "legacy");

  assert.equal(r.stderr, "");
  assert.equal(r.code, 0);
  const lines = r.stdout.split("\n");
  assert.equal(lines[0], "Run legacy-1234, named by --session, from 2026-10-02 01:00 to 2026-10-02 01:02 UTC");
  assert.ok(r.stdout.includes("Owner prompts (2):\n  2026-10-02 01:00  run the open Tickets\n  2026-10-02 01:01  go ahead\n"), r.stdout);
  assert.ok(r.stdout.includes("Agents (0)\n"), r.stdout);
  assert.ok(r.stdout.includes("Log directory, written during the Run (0 entries)\n"), r.stdout);
});

test("run-log --session starts a named session's Run at its last verkstad:orchestrate, through the Skill tool too", (t) => {
  const p = project(t);
  writeSession(p, "mixed", [
    prompt(500, "fix the README first"),
    say(501, "m1", "Fixed."),
    call(510, "m2", "s1", "Skill", { skill: "verkstad:orchestrate" }),
    prompt(511, "go"),
    say(512, "m3", "Nothing is ready."),
  ]);

  const r = p.run("run-log", "--session", "mixed");

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Run mixed, named by --session, from 2026-10-02 04:30 to 2026-10-02 04:32 UTC\n/);
  assert.ok(r.stdout.includes("Owner prompts (1):\n  2026-10-02 04:31  go\n"), r.stdout);
  assert.ok(r.stdout.includes("Orchestrator: 2 turns\n"), r.stdout);
});

test("run-log ends the Run where its session invoked verkstad:reflect, and marks an agent whose task was killed", (t) => {
  const p = project(t);
  const killed = "<task-notification>\n<task-id>b1</task-id>\n<status>killed</status>\n</task-notification>";
  writeSession(
    p,
    "run-then-reflect",
    [
      call(600, "m1", "s1", "Skill", { skill: "verkstad:orchestrate" }),
      call(601, "m2", "o1", "Agent", { description: "Ticket #3 parser", prompt: "You are implementing Ticket #3" }),
      { type: "queue-operation", operation: "enqueue", timestamp: at(605), content: killed },
      call(606, "m3", "o2", "Bash", { command: 'grep -n "verkstad gate" docs/contract.md' }),
      result(606, "o2", "Exit code 1", true),
      prompt(610, "<command-message>verkstad:reflect</command-message>\n<command-name>/verkstad:reflect</command-name>"),
      call(611, "m4", "o3", "Bash", { command: "verkstad run-log" }),
      result(611, "o3", "Exit code 1\nverkstad run-log: no Run found", true),
      prompt(612, "apply the first one"),
    ],
    [
      {
        id: "b1",
        meta: { agentType: "ticket-light", description: "Ticket #3 parser" },
        entries: [prompt(601, "You are implementing Ticket #3"), call(602, "m1", "t1", "Bash", { command: "verkstad gate --quick" }, 9_000), result(604, "t1", "Quick gate passed.")],
      },
      { id: "c1", meta: { agentType: "Explore", description: "Find the Run's errors" }, entries: [prompt(611, "Find errors"), say(612, "m1", "None.")] },
    ],
  );
  logFile(p, "report-3.md", "status: partial\ntier: too low\n", 606);
  logFile(p, "proposals.md", "written while reflecting", 640);

  const r = p.run("run-log");

  assert.equal(r.code, 0, r.stderr);
  assert.equal(
    r.stdout.split("Agents' transcripts")[0].split("\n")[0],
    "Run run-then-reflect, invoked as Skill verkstad:orchestrate, from 2026-10-02 06:00 to 2026-10-02 06:06 UTC",
  );
  assert.ok(r.stdout.includes("Owner prompts (0)\n\nOrchestrator: 3 turns, 1 error\n  Dispatched: 1 agent\n\n"), r.stdout);
  assert.ok(r.stdout.includes('Agents (1):\n  b1  ticket-light  #3  1 turn, context 9k, gate 1, killed  "Ticket #3 parser"\n'), r.stdout);
  assert.ok(r.stdout.includes("Tool errors (1), by kind:\n  1x: exit N from grep\n"), r.stdout);
  assert.ok(r.stdout.endsWith("Log directory, written during the Run (1 entry):\n  report-3.md  status partial, tier too low\n"), r.stdout);
});

test("run-log --log-dir reads the Run's files from another directory", (t) => {
  const p = project(t);
  seedRun(p);
  const other = join(p.dir, "..", "old-logs");
  mkdirSync(other);
  writeFileSync(join(other, "report-12.md"), "status: partial\ntier: too low\n");
  const when = new Date(at(115));
  utimesSync(join(other, "report-12.md"), when, when);

  const r = p.run("run-log", "--log-dir", other);

  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes(`  Log directory: ${other}\n`), r.stdout);
  assert.ok(r.stdout.endsWith("Log directory, written during the Run (1 entry):\n  report-12.md  status partial, tier too low\n"), r.stdout);
});

test("run-log finds a Run started in a worktree of the Project, in the project directory named for the worktree", (t) => {
  const p = project(t);
  const wt = join(realpathSync(p.dir), ".claude", "worktrees", "side");
  writeSession(p, "in-worktree", [prompt(400, ORCHESTRATE), say(401, "m1", "Nothing is ready.")], [], sessionDir(p, wt));

  const r = p.run("run-log");

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Run in-worktree, invoked as \/verkstad:orchestrate, from 2026-10-02 02:40 to 2026-10-02 02:41 UTC\n/);
});

test("run-log fails, saying where it looked, when no session invoked verkstad:orchestrate", (t) => {
  const p = project(t);
  writeSession(p, "chat", [prompt(200, "what does verkstad:orchestrate do?")]);

  const r = p.run("run-log");

  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.equal(
    r.stderr,
    `verkstad run-log: no Run found: no session in ${sessionDir(p)} invoked verkstad:orchestrate; name one with --session <id>\n`,
  );
});

test("run-log fails when --session names no session, or more than one", (t) => {
  const p = project(t);
  writeSession(p, "abc-1", [prompt(0, "one")]);
  writeSession(p, "abc-2", [prompt(0, "two")]);

  const none = p.run("run-log", "--session", "zzz");
  const two = p.run("run-log", "--session", "abc");

  assert.equal(none.code, 1);
  assert.equal(none.stderr, `verkstad run-log: no session zzz in ${sessionDir(p)}\n`);
  assert.equal(two.code, 1);
  assert.equal(two.stderr, "verkstad run-log: --session abc matches more than one session: abc-1, abc-2\n");
});

test("run-log refuses an unknown argument", (t) => {
  const p = project(t);

  const r = p.run("run-log", "--verbose");

  assert.equal(r.code, 2);
  assert.equal(r.stderr, "verkstad run-log: unknown argument '--verbose'; usage: verkstad run-log [--session <id>] [--log-dir <dir>]\n");
});

test("run-log refuses --session without a value", (t) => {
  const p = project(t);

  const r = p.run("run-log", "--session", "--log-dir", "x");

  assert.equal(r.code, 2);
  assert.equal(r.stderr, "verkstad run-log: --session needs a value; usage: verkstad run-log [--session <id>] [--log-dir <dir>]\n");
});
