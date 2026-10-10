import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { project, type Project } from "./project.ts";
import type { StubIssue, StubSession } from "./stub/state.ts";

const GITIGNORE = ".claude/verkstad/\n.claude/worktrees/\n";
const UI = { name: "ui", globs: ["ui/**"] };

function contract(fields: Record<string, unknown> = {}): object {
  return { baseBranch: "main", gate: { steps: [] }, surfaces: [], ...fields };
}

function ready(number: number, more: Partial<StubIssue> = {}): Partial<StubIssue> & { number: number } {
  return { number, title: `Ticket ${number}`, labels: ["ready-for-agent"], ...more };
}

/** A Run's Project: Tickets, a Contract and the sessions the stub `claude` plays. */
function runProject(
  t: Parameters<typeof project>[0],
  issues: Array<Partial<StubIssue> & { number: number }>,
  sessions: StubSession[],
  fields: Record<string, unknown> = {},
  files: Record<string, string> = {},
): Project {
  return project(t, { issues, sessions, contract: contract(fields), files: { ".gitignore": GITIGNORE, ...files } });
}

/** The implementer's report, as its structured output. */
function report(status: "done" | "blocked" | "partial", more: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status,
    worktree: "(the worktree)",
    commits: [],
    what_was_built: "The feature.",
    acceptance_criteria: [{ criterion: "It works", verified_by: "a test" }],
    surfaces: [],
    new_surfaces: [],
    uncertain: [],
    known_bug: false,
    reviewed: true,
    tier: "ok",
    report: `status: ${status}\nWhat was built: the feature.`,
    ...more,
  };
}

/** Shell commands that write a file and commit it on the Ticket's branch. */
function commitFile(n: number, path: string, content: string): string[] {
  return [`mkdir -p "$(dirname ${path})"`, `printf '${content}\\n' > ${path}`, "git add -A", `git commit -q -m "Adds ${path}. Refs #${n}"`];
}

/** An implementer that starts the Ticket, commits `path`, reviews the branch and reports done. */
function implemented(n: number, path: string, more: Record<string, unknown> = {}): StubSession {
  return { run: [`verkstad start ${n}`, ...commitFile(n, path, "built"), "verkstad review record"], report: report("done", more) };
}

/** A Verifier that records `state` for Ticket #n in the worktree it runs in. */
function verifies(n: number, state: string): StubSession {
  return {
    run: [
      `printf '[{"criterion":"It works","seen":"saw it (evidence: it.png)"}]' > ../../verkstad/criteria-${n}.json`,
      `verkstad verdict record ${n} "$PWD" --state ${state} --criteria ../../verkstad/criteria-${n}.json`,
    ],
    report: { verdict: state, worktree: "(the worktree)", question: "none", report: `verdict: ${state}\nCriteria: It works: saw it.` },
  };
}

/** The hand-off files a Run must not leave in the log directory. */
function leftHandoffs(p: Project): string[] {
  return readdirSync(join(p.dir, ".claude", "verkstad")).filter((e) => /^(report|park|verifier|conflict|criteria)-/.test(e));
}

function originSha(p: Project): string {
  return p.git("--git-dir", p.origin, "rev-parse", "--short", "main");
}

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}

test("run implements the one ready Ticket in a worktree of its own, lands it and closes it", (t) => {
  const p = runProject(t, [ready(7)], [implemented(7, "feature.txt")]);

  const r = p.run("run");

  const sha = originSha(p);
  assert.equal(r.stderr, "");
  assert.equal(
    r.stdout,
    [
      "#7 Ticket 7: claimed, standard Tier (opus, medium effort, $25 budget).",
      "#7 implementing in .claude/worktrees/issue-7.",
      "#7 implementer reported done ($0.25).",
      "#7 touches no Surface; landing.",
      `#7 landed on main in ${sha}.`,
      "Run finished: 1 session, $0.25.",
      `  #7 landed on main in ${sha}`,
      "The Run was clean: no Park, failed Landing, wrap-up, Resume, Fix round, Verifier rerun or session with more than 20 failed tool calls.",
      "",
    ].join("\n"),
  );
  assert.equal(r.code, 0);
  assert.equal(p.git("--git-dir", p.origin, "log", "--format=%s", "-1", "main"), "Adds feature.txt. Refs #7");
  const issue = p.state().issues[0];
  assert.equal(issue.state, "closed");
  assert.deepEqual(issue.assignees, ["owner"]);
  assert.match(issue.comments[0].body, /^Landed on main in [0-9a-f]+\.\n\nstatus: done\nWhat was built: the feature\./);
  assert.equal(existsSync(join(p.dir, ".claude", "worktrees", "issue-7")), false);

  const [call] = p.claudeCalls();
  assert.equal(call.cwd, realpathSync(join(p.dir, ".claude", "worktrees")) + "/issue-7");
  assert.equal(flag(call.args, "--model"), "opus");
  assert.equal(flag(call.args, "--effort"), "medium");
  assert.equal(flag(call.args, "--max-turns"), "250");
  assert.equal(flag(call.args, "--max-budget-usd"), "25");
  assert.equal(flag(call.args, "--permission-mode"), "auto");
  assert.equal(flag(call.args, "--add-dir"), realpathSync(join(p.dir, ".claude", "verkstad")));
  assert.match(flag(call.args, "--session-id") ?? "", /^[0-9a-f-]{36}$/);
  assert.match(flag(call.args, "--append-system-prompt") ?? "", /^You implement one Ticket of a Project in a git worktree of your own\. The prompt names the Ticket/);
  assert.match(call.prompt, /^You are implementing Ticket #7 of owner\/project\. /);
  assert.match(call.prompt, /`verkstad start 7`/);
  assert.doesNotMatch(call.prompt, /\{[A-Z_]+\}|^Resume:|^Fix round:|Spec is #/m);
  assert.match(call.prompt, /\n\nThis session has a budget of \$25, and system reminders show what is left\. .* When about 15% is left, start no new work: /);
  assert.deepEqual(leftHandoffs(p), []);
  assert.equal(readdirSync(join(p.dir, ".claude", "verkstad")).filter((e) => /^run-.*\.jsonl$/.test(e)).length, 1);
});

test("run --budget gives every session that budget instead of its Tier's", (t) => {
  const p = runProject(t, [ready(7)], [implemented(7, "a.txt")]);

  const r = p.run("run", "--budget", "7");

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^#7 Ticket 7: claimed, standard Tier \(opus, medium effort, \$7 budget\)\.\n/);
  assert.equal(flag(p.claudeCalls()[0].args, "--max-budget-usd"), "7");
  assert.match(p.claudeCalls()[0].prompt, /This session has a budget of \$7,/);
});

test("run says so and starts nothing when no Ticket is ready", (t) => {
  const p = runProject(t, [ready(7, { assignees: ["owner"] }), ready(8, { blockedBy: [7] })], []);

  const r = p.run("run");

  assert.equal(r.stdout, "Nothing is ready: the Frontier is empty.\n");
  assert.equal(r.stderr, "");
  assert.equal(r.code, 0);
  assert.deepEqual(p.claudeCalls(), []);
});

test("run works the Frontier in order and starts a Ticket a Landing unblocked", (t) => {
  const p = runProject(t, [ready(8, { blockedBy: [7] }), ready(7)], [implemented(7, "a.txt"), implemented(8, "b.txt")]);

  const r = p.run("run");

  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(
    r.stdout.split("\n").filter((l) => / landed on /.test(l) && !l.startsWith("  ")),
    [`#7 landed on main in ${p.git("--git-dir", p.origin, "rev-parse", "--short", "main~1")}.`, `#8 landed on main in ${originSha(p)}.`],
  );
  assert.deepEqual(p.state().issues.map((i) => [i.number, i.state]), [[8, "closed"], [7, "closed"]]);
  assert.match(p.claudeCalls()[1].prompt, /Adds a\.txt\. Refs #7/);
});

test("run --max 1 starts one Ticket and leaves the rest of the Frontier", (t) => {
  const p = runProject(t, [ready(7), ready(9)], [implemented(7, "a.txt")]);

  const r = p.run("run", "--max", "1");

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\nRun finished: 1 session, \$0\.25\.\n  #7 landed on main in [0-9a-f]+\nThe Run was clean: /);
  assert.equal(p.state().issues[1].state, "open");
  assert.deepEqual(p.state().issues[1].assignees, []);
});

test("run --dry-run says which Ticket it would start, on which Tier, and claims nothing", (t) => {
  const p = runProject(t, [ready(7, { labels: ["ready-for-agent", "tier:hard"] }), ready(9)], []);

  const r = p.run("run", "--parallel", "1", "--dry-run");

  assert.equal(r.stdout, "Ready: #7 Ticket 7 (hard), #9 Ticket 9 (standard).\nNext: #7, on the hard Tier (opus, high effort, $35 budget).\n");
  assert.equal(r.code, 0);
  assert.deepEqual(p.state().issues[0].assignees, []);
});

test("run Parks a Ticket whose implementer reports blocked, with its question, and carries on", (t) => {
  const blocked: StubSession = {
    run: ["verkstad start 7", ...commitFile(7, "half.txt", "half")],
    report: report("blocked", { uncertain: ["Which unit do feeds use? I would pick mm/min."] }),
  };
  const p = runProject(t, [ready(7), ready(9)], [blocked, implemented(9, "b.txt")]);

  const r = p.run("run");

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^#7 implementer reported blocked \(\$0\.25\)\.\n#7 parked: blocked: Which unit do feeds use\? I would pick mm\/min\.\n/m);
  assert.match(r.stdout, /\n  #7 parked: blocked: Which unit do feeds use\? I would pick mm\/min\.\n  #9 landed on main in [0-9a-f]+\nSomething for \/verkstad:reflect to learn from: #7 Parked\.\n$/);
  const seven = p.state().issues[0];
  assert.deepEqual(seven.labels, ["needs-info"]);
  assert.deepEqual(seven.assignees, []);
  assert.match(seven.comments[0].body, /^blocked: Which unit do feeds use\? I would pick mm\/min\.\n\nThe implementer's report:\nstatus: blocked/);
  assert.equal(p.git("--git-dir", p.origin, "log", "--format=%s", "-1", "issue-7"), "Adds half.txt. Refs #7");
});

test("run resumes the implementer's own session to review a branch it reported unreviewed, then lands it", (t) => {
  const unreviewed: StubSession = { run: ["verkstad start 7", ...commitFile(7, "a.txt", "built")], report: report("done", { reviewed: false }) };
  const reviewing: StubSession = { run: ["verkstad review record"], report: report("done") };
  const p = runProject(t, [ready(7)], [unreviewed, reviewing]);

  const r = p.run("run");

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^#7 no review of issue-7 is recorded; resuming the implementer's session to review it\.\n/m);
  const [first, second] = p.claudeCalls();
  assert.equal(flag(second.args, "--resume"), flag(first.args, "--session-id"));
  assert.equal(flag(second.args, "--session-id"), undefined);
  assert.equal(second.cwd, first.cwd);
  assert.match(second.prompt, /^No review of issue-7 is recorded\. Run `git merge-base HEAD origin\/main` on its own, review the branch with Skill verkstad:review/);
  assert.equal(p.state().issues[0].state, "closed");
});

test("run nudges a session stopped at its turn limit to commit and report, and routes on that report", (t) => {
  const stopped: StubSession = { run: ["verkstad start 7", ...commitFile(7, "a.txt", "built"), "verkstad review record"], subtype: "error_max_turns" };
  const p = runProject(t, [ready(7)], [stopped, { report: report("done") }]);

  const r = p.run("run");

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^#7 implementer stopped at its turn limit without a report; asking it to commit and report\.\n/m);
  const second = p.claudeCalls()[1];
  assert.equal(flag(second.args, "--resume"), flag(p.claudeCalls()[0].args, "--session-id"));
  assert.equal(flag(second.args, "--max-turns"), "15");
  assert.equal(flag(second.args, "--max-budget-usd"), "10");
  assert.match(second.prompt, /^Your session hit its limit\. Do no new work\. Commit what passes as it stands/);
  assert.match(r.stdout, /\nSomething for \/verkstad:reflect to learn from: #7 implementer asked to wrap up\.\n$/);
  assert.equal(p.state().issues[0].state, "closed");
});

test("run reads a session that gave no report even when asked once more from its branch: its commits make it partial, Resumed one Tier up", (t) => {
  const silent: StubSession = { run: ["verkstad start 7", ...commitFile(7, "a.txt", "half")], subtype: "error_max_budget_usd" };
  const resumed: StubSession = { run: ["verkstad start 7 --resume", ...commitFile(7, "b.txt", "rest"), "verkstad review record"], report: report("done") };
  const p = runProject(t, [ready(7)], [silent, { subtype: "error_max_turns" }, resumed]);

  const r = p.run("run");

  assert.equal(r.code, 0, r.stderr);
  assert.match(
    r.stdout,
    /\n#7 implementer spent its budget without a report; asking it to commit and report\.\n#7 implementer gave no report; its commits make it partial\.\n#7 Resuming on the hard Tier: partial: it gave no report, even when asked; its branch has\n/,
  );
  const third = p.claudeCalls()[2];
  assert.equal(flag(third.args, "--effort"), "high");
  assert.match(third.prompt, /Why it came back: partial: it gave no report, even when asked; its branch has\n[0-9a-f]+ Adds a\.txt\. Refs #7\n/);
  assert.match(r.stdout, /\nSomething for \/verkstad:reflect to learn from: #7 implementer asked to wrap up, read from its branch, Resumed\.\n$/);
  assert.equal(p.state().issues[0].state, "closed");
});

test("run Resumes a partial Ticket once, one Tier up, with what was left as the reason", (t) => {
  const partial: StubSession = {
    run: ["verkstad start 7", ...commitFile(7, "a.txt", "half")],
    report: report("partial", { uncertain: ["The second criterion is not built."] }),
  };
  const resumed: StubSession = { run: ["verkstad start 7 --resume", ...commitFile(7, "b.txt", "rest"), "verkstad review record"], report: report("done") };
  const p = runProject(t, [ready(7, { labels: ["ready-for-agent", "tier:light"] })], [partial, resumed]);

  const r = p.run("run");

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^#7 Ticket 7: claimed, light Tier \(sonnet, medium effort, \$5 budget\)\.\n/);
  assert.match(r.stdout, /\n#7 Resuming on the standard Tier: partial: The second criterion is not built\.\n/);
  const second = p.claudeCalls()[1];
  assert.equal(flag(second.args, "--model"), "opus");
  assert.match(second.prompt, /^Resume: this Ticket was started before\. .*Why it came back: partial: The second criterion is not built\.$/m);
  assert.deepEqual(p.git("--git-dir", p.origin, "log", "--format=%s", "-2", "main").split("\n"), ["Adds b.txt. Refs #7", "Adds a.txt. Refs #7"]);
});

test("run Resumes a Ticket whose Landing's Gate failed, and Parks it when the Gate fails again", (t) => {
  const broken = (resume: boolean): StubSession => ({
    run: [`verkstad start 7${resume ? " --resume" : ""}`, ...commitFile(7, resume ? "broken2.txt" : "broken.txt", "x"), "verkstad review record"],
    report: report("done"),
  });
  const p = runProject(t, [ready(7)], [broken(false), broken(true)], { gate: { steps: [{ name: "no breakage", command: "test ! -e broken.txt" }] } });

  const r = p.run("run");

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\n#7 Landing failed: gate-failed\.\n#7 Resuming on the standard Tier: Landing failed \(gate-failed\): /);
  assert.match(r.stdout, /\n#7 parked: Resumed once, and Landing failed again \(gate-failed\)\.\n/);
  assert.match(r.stdout, /\nSomething for \/verkstad:reflect to learn from: #7 Landing failed \(gate-failed\), Resumed, Parked\.\n$/);
  assert.match(p.claudeCalls()[1].prompt, /^Resume: .*Why it came back: Landing failed \(gate-failed\): #7 did not land: the Gate failed: /m);
  const seven = p.state().issues[0];
  assert.deepEqual(seven.labels, ["needs-info"]);
  assert.match(seven.comments[0].body, /^Resumed once, and Landing failed again \(gate-failed\)\.\n\n#7 did not land: the Gate failed: /);
});

test("run Parks a Ticket whose Landing ends contract-narrowed, with Landing's message and that narrowing is the owner's", (t) => {
  const narrowed = JSON.stringify(contract({ verify: "verify-app" }));
  const narrowing: StubSession = {
    run: ["verkstad start 7", `printf '%s\\n' '${narrowed}' > .claude/harness.json`, "git commit -q -am 'Drops the Surface ui. Refs #7'", "verkstad review record"],
    report: report("done"),
  };
  const p = runProject(t, [ready(7)], [narrowing], { surfaces: [UI], verify: "verify-app" });

  const r = p.run("run");

  assert.equal(r.code, 0, r.stderr);
  const why = "Landing refused a branch that narrows the Contract: #7 did not land: issue-7 narrows the Contract: it removes the Surface ui.";
  assert.ok(r.stdout.includes(`\n#7 Landing failed: contract-narrowed.\n#7 parked: ${why}\n`), r.stdout);
  const seven = p.state().issues[0];
  assert.deepEqual(seven.labels, ["needs-info"]);
  assert.equal(
    seven.comments[0].body.split("\n\nParked:")[0],
    `${why}\n\n` +
      "Narrowing the Contract's Surfaces or its verify is the owner's, through verkstad:maintain-verify; an implementer may only add to them.",
  );
  assert.equal(p.git("--git-dir", p.origin, "log", "--format=%s", "-1", "issue-7"), "Drops the Surface ui. Refs #7");
});

test("run has the Verifier Walk a branch that touches a Surface, blind to the report, and lands it live-verified", (t) => {
  const p = runProject(
    t,
    [ready(7)],
    [implemented(7, "ui/panel.txt", { report: "status: done\nSECRET implementer notes" }), verifies(7, "live-verified")],
    { surfaces: [UI], verify: "verify-app" },
  );

  const r = p.run("run");

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\n#7 touches ui; the Verifier Walks it\.\n#7 Verdict: live-verified \(\$0\.25\)\.\n#7 landed on main in /);
  const verifier = p.claudeCalls()[1];
  assert.equal(verifier.cwd, p.claudeCalls()[0].cwd);
  assert.equal(flag(verifier.args, "--disallowedTools"), "Edit,NotebookEdit");
  assert.equal(flag(verifier.args, "--max-turns"), "120");
  assert.match(verifier.prompt, /When about 15% is left, Walk nothing more: record the Verdict/);
  assert.match(verifier.prompt, /^You are the Verifier for Ticket #7 of owner\/project\. /);
  assert.match(verifier.prompt, /^The Surfaces to Walk are ui: /m);
  assert.match(verifier.prompt, /with the Project's Verify skill, verify-app,/);
  assert.doesNotMatch(verifier.prompt, /SECRET|\{[A-Z_]+\}|^Fix round:/m);
  assert.match(p.state().issues[0].comments[0].body, /live-verified/);
  assert.deepEqual(leftHandoffs(p), [], "the criteria file goes once the Verdict holds it");
});

test("run sends a failed Verdict back to the implementer as its Fix round, Walks again and lands", (t) => {
  const fixing: StubSession = { run: ["verkstad start 7 --resume", ...commitFile(7, "ui/fix.txt", "fixed"), "verkstad review record"], report: report("done") };
  const p = runProject(
    t,
    [ready(7)],
    [implemented(7, "ui/panel.txt"), verifies(7, "failed"), fixing, verifies(7, "live-verified")],
    { surfaces: [UI], verify: "verify-app" },
  );

  const r = p.run("run");

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\n#7 Verdict: failed \(\$0\.25\)\.\n#7 Fix round on the standard Tier\.\n/);
  assert.match(r.stdout, /\nSomething for \/verkstad:reflect to learn from: #7 a Fix round\.\n$/);
  const [, , fix, verifier] = p.claudeCalls();
  assert.match(fix.prompt, /^Fix round: this Ticket is implemented on issue-7, .*Its findings: verdict: failed\nCriteria: It works: saw it\./m);
  assert.match(verifier.prompt, /^Fix round: this branch was Walked before, and its Verdict was failed\. .*It works: saw it \(evidence: it\.png\)/m);
  assert.equal(p.state().issues[0].state, "closed");
});

test("run has the Verifier Walk once more when it records no Verdict, and names the rerun for reflect", (t) => {
  const silent: StubSession = { report: { verdict: "live-verified", worktree: "(the worktree)", question: "none", report: "verdict: live-verified" } };
  const p = runProject(t, [ready(7)], [implemented(7, "ui/panel.txt"), silent, verifies(7, "live-verified")], { surfaces: [UI], verify: "verify-app" });

  const r = p.run("run");

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\n#7 the Verifier recorded no Verdict for this patch \(\$0\.25\)\.\n#7 touches ui; the Verifier Walks it\.\n/);
  assert.match(r.stdout, /\nSomething for \/verkstad:reflect to learn from: #7 a Verifier rerun\.\n$/);
  assert.equal(p.state().issues[0].state, "closed");
});

test("run names for reflect a session with more than 20 failed tool calls, and not one with 20", (t) => {
  const p = runProject(t, [ready(7), ready(9)], [
    { ...implemented(7, "a.txt"), failedToolCalls: 20 },
    { ...implemented(9, "b.txt"), failedToolCalls: 21 },
  ]);

  const r = p.run("run");

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\n  #9 landed on main in [0-9a-f]+\nSomething for \/verkstad:reflect to learn from: #9 an implementer session with 21 failed tool calls\.\n$/);
});

test("run has the conflict prompt finish a Ticket whose Landing conflicted with what landed meanwhile, then lands it", (t) => {
  const racing: StubSession = {
    run: [
      "verkstad start 7",
      // Another Ticket lands on main while #7 is implemented.
      "git worktree add -q --detach ../other origin/main && cd ../other && printf 'theirs\\n' > a.txt && git commit -qam 'Another Ticket landed' && git push -q origin HEAD:main && cd - >/dev/null && git worktree remove --force ../other",
      "printf 'ours\\n' > a.txt && git commit -qam 'Changes a.txt. Refs #7'",
      "verkstad review record",
    ],
    report: report("done"),
  };
  const finishing: StubSession = {
    run: ["verkstad start 7 --resume || true", "printf 'ours and theirs\\n' > a.txt && git add a.txt && GIT_EDITOR=true git rebase --continue"],
    report: { status: "done", worktree: "(the worktree)", commits: [], uncertain: [], report: "status: done\nResolved: a.txt, both lines kept." },
  };
  const p = runProject(t, [ready(7)], [racing, finishing], {}, { "a.txt": "base\n" });

  const r = p.run("run");

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\n#7 Landing failed: conflict\.\n#7 conflicts with main in a\.txt; finishing it on the light Tier\.\n#7 conflict finisher reported done \(\$0\.25\)\.\n/);
  assert.match(r.stdout, /\nSomething for \/verkstad:reflect to learn from: #7 Landing failed \(conflict\)\.\n$/);
  const finisher = p.claudeCalls()[1];
  assert.equal(flag(finisher.args, "--model"), "sonnet");
  assert.match(finisher.prompt, /^You are finishing Ticket #7 of owner\/project\. /);
  assert.match(finisher.prompt, /rebasing onto origin\/main conflicted in a\.txt\. Since issue-7 branched, these landed on main:\n[0-9a-f]+ Another Ticket landed\n/);
  assert.equal(p.git("--git-dir", p.origin, "show", "main:a.txt"), "ours and theirs");
  assert.equal(p.state().issues[0].state, "closed");
  assert.match(p.state().issues[0].comments[0].body, /\n\nRebasing onto main conflicted; the conflict finisher reported:\nstatus: done\nResolved: a\.txt, both lines kept\.\n/);
});

const CLI_SURFACE = { name: "cli", globs: ["cli.txt", "bin/**"], observes: "the first CLI command and what it prints" };

test("run stops after landing a Ticket that adds a Surface, in a Project whose Contract names no Verify skill", (t) => {
  const p = runProject(t, [ready(7), ready(9)], [implemented(7, "cli.txt", { new_surfaces: [CLI_SURFACE] })]);

  const r = p.run("run", "--parallel", "1");

  assert.equal(r.code, 0, r.stderr);
  assert.match(
    r.stdout,
    /\n#7 added a Surface the Contract lacks: cli \(the first CLI command and what it prints\)\. Stopping: the Project has no Verify skill yet; run \/verkstad:setup to declare it, then \/verkstad:create-verify\.\n/,
  );
  assert.equal(p.state().issues.length, 2);
  assert.equal(p.state().issues[1].state, "open");
  assert.equal(p.claudeCalls().length, 1);
});

test("run files a Ticket to declare a Surface a landed Ticket added, under its Spec, and works it next, Walked on the new Surface", (t) => {
  const declared = JSON.stringify(contract({ surfaces: [UI, { name: "cli", globs: ["cli.txt", "bin/**"] }], verify: "verify-app" }));
  const declaring: StubSession = {
    run: [
      "verkstad start 10",
      `printf '%s\\n' '${declared}' > .claude/harness.json`,
      "git commit -q -am 'Declares the Surface cli. Refs #10'",
      "verkstad review record",
    ],
    report: report("done"),
  };
  const p = runProject(
    t,
    [{ number: 3, title: "The Spec", labels: [] }, ready(7, { parent: 3 }), ready(9)],
    [implemented(7, "cli.txt", { new_surfaces: [CLI_SURFACE] }), declaring, verifies(10, "live-verified"), implemented(9, "b.txt")],
    { surfaces: [UI], verify: "verify-app" },
  );

  const r = p.run("run", "--parallel", "1");

  assert.equal(r.code, 0, r.stderr);
  const title = "Declare the cli Surface and teach the Verify skill to drive it";
  assert.ok(
    r.stdout.includes(`\n#7 added a Surface the Contract lacks: cli (the first CLI command and what it prints); filed #10 to declare it, next.\n#10 ${title}: claimed, `),
    r.stdout,
  );
  assert.match(r.stdout, /\n#10 touches cli; the Verifier Walks it\.\n#10 Verdict: live-verified \(\$0\.25\)\.\n#10 landed on main in [0-9a-f]+\.\n#9 Ticket 9: claimed, /);
  assert.match(r.stdout, /\nRun finished: 4 sessions, \$1\.00\.\n  #7 landed on main in [0-9a-f]+\n  #10 landed on main in [0-9a-f]+\n  #9 landed on main in [0-9a-f]+\nThe Run was clean: /);

  const filed = p.state().issues.find((i) => i.number === 10);
  assert.ok(filed);
  assert.equal(filed.title, title);
  assert.deepEqual(filed.labels, ["ready-for-agent"]);
  assert.equal(filed.parent, 3);
  assert.equal(filed.state, "closed");
  assert.equal(
    filed.body,
    [
      "## Parent",
      "",
      "#3",
      "",
      "## What to build",
      "",
      "#7 added a Surface the Contract does not declare: the first CLI command and what it prints. Declare it as the Surface cli, " +
        "with the globs whose changes can alter it, and teach the Project's Verify skill to drive it, so that the Verifier Walks " +
        "every later Ticket that changes it.",
      "",
      "## Acceptance criteria",
      "",
      "- [ ] The Contract declares the Surface cli with the globs `cli.txt`, `bin/**`",
      "- [ ] The Verify skill's Feature map has an entry for cli, and its driving tool a command for it where one is needed",
      "- [ ] The Verifier Walks cli with the Verify skill as this branch changed it",
      "",
      "## Blocked by",
      "",
      "None - can start immediately",
      "",
    ].join("\n"),
  );
  const implementing = p.claudeCalls()[1];
  assert.match(implementing.prompt, /^You are implementing Ticket #10 of owner\/project\. /);
  assert.match(implementing.prompt, /The Ticket's Spec is #3;/);
  assert.match(p.claudeCalls()[2].prompt, /^The Surfaces to Walk are cli: /m);
});

test("run files the declaring Ticket with no Parent when the landed Ticket has no Spec", (t) => {
  const p = runProject(t, [ready(7)], [implemented(7, "cli.txt", { new_surfaces: [CLI_SURFACE] })], { verify: "verify-app" }, {});

  const r = p.run("run", "--max", "1");

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\n#7 added a Surface the Contract lacks: cli \(the first CLI command and what it prints\); filed #8 to declare it, next\.\n/);
  const filed = p.state().issues.find((i) => i.number === 8);
  assert.ok(filed);
  assert.equal(filed.parent, null);
  assert.match(filed.body, /^## What to build\n\n#7 added a Surface/);
  assert.deepEqual(filed.assignees, []);
  assert.ok(!p.calls().some((c) => c.join(" ").includes("sub_issues")));
});

test("run files the declaring Ticket blocked by a Ticket whose pull request waits on the owner, and does not work it yet", (t) => {
  const p = runProject(t, [ready(7), ready(9)], [implemented(7, "cli.txt", { new_surfaces: [CLI_SURFACE] }), implemented(9, "b.txt")], {
    verify: "verify-app",
    landing: "pull-request",
  });

  const r = p.run("run", "--parallel", "1");

  assert.equal(r.code, 0, r.stderr);
  assert.ok(
    r.stdout.includes("\n#7 added a Surface the Contract lacks: cli (the first CLI command and what it prints); filed #11 to declare it, blocked by #7 until its pull request is merged.\n#9 Ticket 9: claimed, "),
    r.stdout,
  );
  const filed = p.state().issues.find((i) => i.number === 11);
  assert.ok(filed);
  assert.deepEqual(filed.blockedBy, [7]);
  assert.equal(filed.state, "open");
  assert.match(filed.body, /\n## Blocked by\n\n- #7\n$/);
  assert.equal(p.claudeCalls().length, 2);
});

test("run Parks a branch that declares a Surface in a Project whose Contract names no Verify skill", (t) => {
  const declared = JSON.stringify(contract({ surfaces: [UI] }));
  const declaring: StubSession = {
    run: ["verkstad start 7", `printf '%s\\n' '${declared}' > .claude/harness.json`, "git commit -q -am 'Declares the Surface ui. Refs #7'", "verkstad review record"],
    report: report("done"),
  };
  const p = runProject(t, [ready(7)], [declaring]);

  const r = p.run("run");

  assert.equal(r.code, 0, r.stderr);
  assert.ok(
    r.stdout.includes(
      "\n#7 parked: It touches ui, but the Contract names no Verify skill to Walk it with: the first one is the owner's, through verkstad:create-verify.\n",
    ),
    r.stdout,
  );
  assert.deepEqual(p.state().issues[0].labels, ["needs-info"]);
  assert.equal(p.claudeCalls().length, 1);
});

test("the stub claude refuses a new Surface reported without a glob", (t) => {
  const p = runProject(t, [ready(7)], [implemented(7, "cli.txt", { new_surfaces: [{ ...CLI_SURFACE, globs: [] }] })], { verify: "verify-app" });

  const r = p.run("run");

  assert.equal(r.code, 1);
  assert.match(r.stderr, /stub claude: the report\.new_surfaces\[0\]\.globs has fewer than 1 items/);
});

test("run stops, leaving the Ticket claimed, when a session fails without a report", (t) => {
  const p = runProject(t, [ready(7), ready(9)], [{ subtype: "error_during_execution" }]);

  const r = p.run("run", "--parallel", "1");

  assert.equal(r.code, 1);
  assert.match(r.stderr, /^verkstad run: #7's implementing session failed \(error_during_execution\) without a report; /);
  assert.match(r.stdout, /\nRun stopped: 1 session, \$0\.25\.\nSomething for \/verkstad:reflect to learn from: #7 stopped the Run\.\n$/);
  assert.deepEqual(p.state().issues[0].assignees, ["owner"]);
  assert.deepEqual(p.state().issues[1].assignees, []);
});

test("run refuses a main checkout with uncommitted changes, starting nothing", (t) => {
  const p = runProject(t, [ready(7)], []);
  p.git("rm", "--quiet", "docs/agents/project.md");

  const r = p.run("run");

  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "verkstad run: the main checkout has uncommitted changes; commit or stash them first\n");
  assert.equal(r.code, 1);
  assert.deepEqual(p.calls(), []);
});

/** Shell commands that record in `seen.txt`, committed on the Ticket's branch, whether the scratch directory is there. */
function seesScratch(n: number): string[] {
  return ['printf "%s\\n" "$(test -d .claude/verkstad && echo present || echo missing)" > seen.txt', "git add -A", `git commit -q -m "Records the scratch directory. Refs #${n}"`];
}

test("run makes the Ticket's worktree with its scratch directory before the implementer starts", (t) => {
  const p = runProject(t, [ready(7)], [
    { run: ["verkstad start 7", ...seesScratch(7), "verkstad review record"], report: report("done") },
  ]);

  const r = p.run("run");

  assert.equal(r.code, 0, r.stderr);
  assert.equal(p.git("--git-dir", p.origin, "show", "main:seen.txt"), "present");
});

test("run makes the scratch directory in the fresh worktree of a Resume", (t) => {
  const partial: StubSession = { run: ["verkstad start 7", ...commitFile(7, "a.txt", "half")], report: report("partial") };
  const resumed: StubSession = { run: ["verkstad start 7 --resume", ...seesScratch(7), "verkstad review record"], report: report("done") };
  const p = runProject(t, [ready(7)], [partial, resumed]);

  const r = p.run("run");

  assert.equal(r.code, 0, r.stderr);
  assert.equal(p.git("--git-dir", p.origin, "show", "main:seen.txt"), "present");
});

test("run makes the scratch directory in the fresh worktree of a Fix round", (t) => {
  const fixing: StubSession = { run: ["verkstad start 7 --resume", ...seesScratch(7), "verkstad review record"], report: report("done") };
  const p = runProject(t, [ready(7)], [implemented(7, "ui/panel.txt"), verifies(7, "failed"), fixing, verifies(7, "live-verified")], { surfaces: [UI], verify: "verify-app" });

  const r = p.run("run");

  assert.equal(r.code, 0, r.stderr);
  assert.equal(p.git("--git-dir", p.origin, "show", "main:seen.txt"), "present");
});

test("run refuses a Project that does not gitignore .claude/verkstad/, making no worktree", (t) => {
  const p = runProject(t, [ready(7)], [], {}, { ".gitignore": ".claude/worktrees/\n" });

  const r = p.run("run");

  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "verkstad run: .claude/verkstad/ is not gitignored; add it to the Project's .gitignore\n");
  assert.equal(r.code, 1);
  assert.equal(existsSync(join(p.dir, ".claude", "worktrees")), false);
  assert.deepEqual(p.calls(), []);
});

/** Waits until `ready` holds, checking every 50ms, failing after `ms`. */
async function waitFor(what: string, ready: () => boolean, ms = 20_000): Promise<void> {
  for (const until = Date.now() + ms; !ready(); ) {
    if (Date.now() > until) throw new Error(`waited ${ms}ms for ${what}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

/** The Run's event log, one object per line. */
function eventLog(p: Project): Array<Record<string, unknown>> {
  const dir = join(p.dir, ".claude", "verkstad");
  const [name] = readdirSync(dir).filter((e) => /^run-.*\.jsonl$/.test(e));
  return readFileSync(join(dir, name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** A file under the test's TMPDIR, where a session's or a Gate step's commands leave signs for the test. */
function sign(p: Project, name: string): string {
  return join(p.env.TMPDIR ?? "", name);
}

/** Shell commands that say the session or step has started, then wait for the test to write `go`. */
const WAIT_FOR_GO = 'touch "$TMPDIR/working"; while [ ! -e "$TMPDIR/go" ]; do sleep 0.1; done';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const CLEAN =
  "The Run was clean: no Park, failed Landing, wrap-up, Resume, Fix round, Verifier rerun or session with more than 20 failed tool calls.";

test("run --stop lets the Run land the Ticket it is on, then end without claiming another", async (t) => {
  const working: StubSession = { ...implemented(7, "a.txt"), run: [...(implemented(7, "a.txt").run ?? []), WAIT_FOR_GO] };
  const p = runProject(t, [ready(7), ready(9)], [working, implemented(9, "b.txt")]);
  const running = p.start(p.dir, "run", "--parallel", "1");
  await waitFor("the implementer to start", () => existsSync(sign(p, "working")));

  const s = p.run("run", "--stop");

  assert.equal(s.stderr, "");
  assert.equal(s.stdout, "The Run stops after #7.\n");
  assert.equal(s.code, 0);
  writeFileSync(sign(p, "go"), "");
  const r = await running;
  const sha = originSha(p);
  assert.equal(r.stderr, "");
  assert.equal(
    r.stdout,
    [
      "#7 Ticket 7: claimed, standard Tier (opus, medium effort, $25 budget).",
      "#7 implementing in .claude/worktrees/issue-7.",
      "#7 implementer reported done ($0.25).",
      "#7 touches no Surface; landing.",
      `#7 landed on main in ${sha}.`,
      "Run finished: 1 session, $0.25.",
      `  #7 landed on main in ${sha}`,
      "Stopped at the owner's request.",
      CLEAN,
      "",
    ].join("\n"),
  );
  assert.equal(r.code, 0);
  assert.deepEqual(p.state().issues.map((i) => [i.number, i.state, i.assignees]), [[7, "closed", ["owner"]], [9, "open", []]]);
  assert.equal(p.claudeCalls().length, 1);
  const events = eventLog(p);
  assert.equal(events[0].run, "started");
  assert.equal(typeof events[0].pid, "number");
  assert.equal(events.filter((e) => "asked" in e && !("run" in e)).map((e) => e.asked).join(), "stop");
  const { at: _, ...end } = events[events.length - 1];
  assert.deepEqual(end, { run: "finished", sessions: 1, cost: 0.25, finished: [{ n: 7, line: `landed on main in ${sha}` }], asked: "stop" });
});

test("run --abort kills the implementer session and what it started, discards the Ticket's work and puts it back on the Frontier", async (t) => {
  const working: StubSession = {
    run: [
      "verkstad start 7",
      ...commitFile(7, "a.txt", "half"),
      "verkstad review record",
      // An orphan: its parent, the subshell, ends at once, so only the session's process group still holds it.
      `(sleep 60 & echo $! > "$TMPDIR/orphan"); sleep 60 & echo "$PPID $$ $! $(cat "$TMPDIR/orphan")" > "$TMPDIR/pids"; ${WAIT_FOR_GO}`,
    ],
    report: report("done"),
  };
  const p = runProject(t, [ready(7), ready(9)], [working, implemented(9, "b.txt")]);
  const running = p.start(p.dir, "run", "--parallel", "1");
  await waitFor("the implementer to start", () => existsSync(sign(p, "working")));
  const pids = readFileSync(sign(p, "pids"), "utf8").trim().split(" ").map(Number);
  assert.equal(pids.length, 4);
  assert.ok(pids.every(isAlive));

  const s = p.run("run", "--abort");

  assert.equal(s.stderr, "");
  assert.equal(s.stdout, "The Run aborts #7 and discards its work.\n");
  assert.equal(s.code, 0);
  await waitFor("the session and its children to be gone", () => !pids.some(isAlive), 10_000);
  const r = await running;
  assert.equal(r.stderr, "");
  assert.equal(
    r.stdout,
    [
      "#7 Ticket 7: claimed, standard Tier (opus, medium effort, $25 budget).",
      "#7 implementing in .claude/worktrees/issue-7.",
      "Run aborted: 1 session, $0.00.",
      "Aborted at the owner's request: #7's work was discarded: the worktree .claude/worktrees/issue-7, the branch issue-7, its review record.",
      CLEAN,
      "",
    ].join("\n"),
  );
  assert.equal(r.code, 0);
  assert.equal(existsSync(join(p.dir, ".claude", "worktrees", "issue-7")), false);
  assert.equal(p.git("branch", "--list", "issue-7"), "");
  assert.equal(existsSync(join(p.dir, ".claude", "verkstad", "review-issue-7.json")), false);
  const [seven, nine] = p.state().issues;
  assert.equal(seven.state, "open");
  assert.deepEqual(seven.assignees, []);
  assert.deepEqual(seven.labels, ["ready-for-agent"]);
  assert.deepEqual(seven.comments.map((c) => c.body), ["Aborted by the owner during a Run; its work was discarded and the next Run starts it afresh."]);
  assert.deepEqual(nine.assignees, []);
  assert.equal(p.claudeCalls().length, 1);
  const events = eventLog(p).map(({ at: _, ...e }) => e);
  assert.deepEqual(events.filter((e) => "asked" in e), [{ asked: "abort" }]);
  assert.deepEqual(events.slice(-2), [
    { ticket: 7, aborted: "the worktree .claude/worktrees/issue-7, the branch issue-7, its review record" },
    { run: "aborted", sessions: 1, cost: 0, finished: [] },
  ]);
});

test("run --abort deletes the branch an earlier Park left on origin", async (t) => {
  const working: StubSession = { run: ["verkstad start 7 --resume", WAIT_FOR_GO], report: report("done") };
  const p = runProject(t, [ready(7)], [working]);
  p.git("push", "--quiet", "origin", "main:refs/heads/issue-7");
  const running = p.start(p.dir, "run");
  await waitFor("the implementer to start", () => existsSync(sign(p, "working")));

  const s = p.run("run", "--abort");

  assert.equal(s.code, 0, s.stderr);
  const r = await running;
  assert.equal(r.code, 0, r.stderr);
  assert.match(
    r.stdout,
    /\nAborted at the owner's request: #7's work was discarded: the worktree \.claude\/worktrees\/issue-7, the branch issue-7, issue-7 on origin\.\n/,
  );
  assert.equal(p.git("--git-dir", p.origin, "branch", "--list", "issue-7"), "");
  assert.equal(p.git("branch", "--list", "issue-7"), "");
});

test("run --abort asked during a Landing lets it land, and the Run ends aborted with nothing discarded", async (t) => {
  const p = runProject(t, [ready(7), ready(9)], [implemented(7, "a.txt"), implemented(9, "b.txt")], {
    gate: { steps: [{ name: "slow", command: WAIT_FOR_GO }] },
  });
  const running = p.start(p.dir, "run", "--parallel", "1");
  await waitFor("the Landing's Gate to start", () => existsSync(sign(p, "working")));

  const s = p.run("run", "--abort");

  assert.equal(s.code, 0, s.stderr);
  writeFileSync(sign(p, "go"), "");
  const r = await running;
  const sha = originSha(p);
  assert.equal(r.stderr, "");
  assert.match(
    r.stdout,
    new RegExp(
      `\\n#7 landed on main in ${sha}\\.\\nRun aborted: 1 session, \\$0\\.25\\.\\n  #7 landed on main in ${sha}\\n` +
        "Aborted at the owner's request: no Ticket was in flight, so nothing was discarded\\.\\n",
    ),
  );
  assert.equal(r.code, 0);
  assert.equal(p.git("--git-dir", p.origin, "log", "--format=%s", "-1", "main"), "Adds a.txt. Refs #7");
  const [seven, nine] = p.state().issues;
  assert.equal(seven.state, "closed");
  assert.deepEqual(seven.comments.map((c) => c.body.split("\n")[0]), [`Landed on main in ${sha}.`]);
  assert.deepEqual(nine.assignees, []);
  const events = eventLog(p).map(({ at: _, ...e }) => e);
  assert.deepEqual(events.filter((e) => "aborted" in e), []);
  assert.deepEqual(events[events.length - 1], { run: "aborted", sessions: 1, cost: 0.25, finished: [{ n: 7, line: `landed on main in ${sha}` }] });
});

test("run --stop and --abort fail with no Run going: no event log, one that ended, or one whose process is gone", (t) => {
  const p = runProject(t, [ready(7)], []);
  const dir = join(p.dir, ".claude", "verkstad");
  const refused = (args: string[]) => {
    for (const arg of args) {
      const r = p.run("run", arg);
      assert.equal(r.stdout, "");
      assert.equal(r.stderr, "verkstad run: no Run is going\n");
      assert.equal(r.code, 1);
    }
  };

  refused(["--stop", "--abort"]);

  mkdirSync(dir);
  const ended = '{"run":"started","pid":' + process.pid + "}\n" + '{"run":"finished","sessions":0,"cost":0,"finished":[]}\n';
  writeFileSync(join(dir, "run-2026-10-08T10-00-00-000Z.jsonl"), ended);
  refused(["--stop", "--abort"]);

  const gone = spawnSync("true").pid;
  const killed = '{"run":"started","pid":' + gone + "}\n" + '{"ticket":7,"claimed":"Ticket 7","tier":"standard"}\n';
  writeFileSync(join(dir, "run-2026-10-08T11-00-00-000Z.jsonl"), killed);
  refused(["--stop", "--abort"]);
  assert.equal(readFileSync(join(dir, "run-2026-10-08T11-00-00-000Z.jsonl"), "utf8"), killed);

  const usage = p.run("run", "--stop", "--max", "1");
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /^verkstad run: usage: verkstad run /);
});

/** A shell command that says Ticket #n's session has started, then waits until #m's has too, failing after 20 seconds. */
function meets(n: number, m: number): string {
  return `touch "$TMPDIR/started-${n}"; i=0; until [ -e "$TMPDIR/started-${m}" ]; do i=$((i+1)); [ $i -lt 200 ] || { echo "#${m} never started" >&2; exit 1; }; sleep 0.1; done`;
}

/** A shell command that waits until a commit of Ticket #m is on origin's main, failing after 20 seconds. */
function afterLanding(m: number): string {
  return `i=0; until git fetch -q origin main && git log --format=%s FETCH_HEAD | grep -q "Refs #${m}$"; do i=$((i+1)); [ $i -lt 200 ] || { echo "#${m} never landed" >&2; exit 1; }; sleep 0.1; done`;
}

/** Ticket #n's implementer, which starts once #m's has, commits `path`, and then runs `after`. */
function besides(n: number, m: number, path: string, content: string, after: string[] = []): StubSession {
  return { ticket: n, run: [meets(n, m), `verkstad start ${n}`, ...commitFile(n, path, content), "verkstad review record", ...after], report: report("done") };
}

/** The prompt of the first session the stub `claude` played in Ticket #n's worktree. */
function promptIn(p: Project, n: number): string {
  const call = p.claudeCalls().find((c) => c.cwd.endsWith(`/issue-${n}`));
  assert.ok(call, `no session ran for #${n}`);
  return call.prompt;
}

test("run --parallel 2 works two ready Tickets side by side, tells each implementer of the other, and lands the second rebased onto the first", (t) => {
  const p = runProject(t, [ready(7), ready(9)], [besides(7, 9, "a.txt", "seven"), besides(9, 7, "b.txt", "nine", [afterLanding(7)])]);

  const r = p.run("run", "--parallel", "2");

  assert.equal(r.stderr, "");
  const [nine, seven] = p.git("--git-dir", p.origin, "log", "--format=%h %p %s", "-2", "main").split("\n").map((l) => l.split(" "));
  assert.deepEqual([seven.slice(2).join(" "), nine.slice(2).join(" ")], ["Adds a.txt. Refs #7", "Adds b.txt. Refs #9"]);
  assert.equal(nine[1], seven[0], "#9 landed on #7's commit");
  assert.equal(
    r.stdout,
    [
      "#7 Ticket 7: claimed, standard Tier (opus, medium effort, $25 budget).",
      "#7 implementing in .claude/worktrees/issue-7.",
      "#9 Ticket 9: claimed, standard Tier (opus, medium effort, $25 budget).",
      "#9 implementing in .claude/worktrees/issue-9.",
      "#7 implementer reported done ($0.25).",
      "#7 touches no Surface; landing.",
      `#7 landed on main in ${seven[0]}.`,
      "#9 implementer reported done ($0.25).",
      "#9 touches no Surface; landing.",
      `#9 landed on main in ${nine[0]}.`,
      "Run finished: 2 sessions, $0.50.",
      `  #7 landed on main in ${seven[0]}`,
      `  #9 landed on main in ${nine[0]}`,
      CLEAN,
      "",
    ].join("\n"),
  );
  assert.equal(r.code, 0);
  assert.deepEqual(p.state().issues.map((i) => [i.number, i.state]), [[7, "closed"], [9, "closed"]]);
  const others = "Other agents are implementing these Tickets at the same time, each in a worktree of its own:";
  assert.ok(promptIn(p, 7).includes(` ${others} #9 Ticket 9. Keep out of the code they change; where you cannot, say so in the report.\n`), promptIn(p, 7));
  assert.ok(promptIn(p, 9).includes(` ${others} #7 Ticket 7. Keep out of the code they change; where you cannot, say so in the report.\n`), promptIn(p, 9));
});

test("run --parallel 2 has a conflict session finish the second of two Tickets that change the same lines, and lands it", (t) => {
  const finishing: StubSession = {
    ticket: 9,
    run: ["verkstad start 9 --resume || true", "printf 'seven and nine\\n' > a.txt && git add a.txt && GIT_EDITOR=true git rebase --continue"],
    report: { status: "done", worktree: "(the worktree)", commits: [], uncertain: [], report: "status: done\nResolved: a.txt, both kept." },
  };
  const p = runProject(t, [ready(7), ready(9)], [besides(7, 9, "a.txt", "seven"), besides(9, 7, "a.txt", "nine", [afterLanding(7)]), finishing], {}, { "a.txt": "base\n" });

  const r = p.run("run", "--parallel", "2");

  assert.equal(r.code, 0, r.stderr);
  assert.ok(
    r.stdout.includes("\n#9 Landing failed: conflict.\n#9 conflicts with main in a.txt; finishing it on the light Tier.\n#9 conflict finisher reported done ($0.25).\n"),
    r.stdout,
  );
  assert.equal(p.git("--git-dir", p.origin, "show", "main:a.txt"), "seven and nine");
  assert.deepEqual(p.state().issues.map((i) => [i.number, i.state]), [[7, "closed"], [9, "closed"]]);
  assert.deepEqual(
    eventLog(p).filter((e) => typeof e.say === "string" && e.say.startsWith("conflicts")).map(({ at: _, ...e }) => e),
    [{ ticket: 9, say: "conflicts with main in a.txt; finishing it on the light Tier." }],
  );
});

test("run --stop asked while two Tickets are in flight lands both and claims no third", async (t) => {
  const waiting = (n: number, m: number, path: string): StubSession => besides(n, m, path, "built", [WAIT_FOR_GO]);
  const p = runProject(t, [ready(7), ready(9), ready(11)], [waiting(7, 9, "a.txt"), waiting(9, 7, "b.txt"), implemented(11, "c.txt")]);
  const running = p.start(p.dir, "run", "--parallel", "2");
  await waitFor("both implementers to start", () => existsSync(sign(p, "started-7")) && existsSync(sign(p, "started-9")));

  const s = p.run("run", "--stop");

  assert.equal(s.stderr, "");
  assert.equal(s.stdout, "The Run stops after #7 and #9.\n");
  assert.equal(s.code, 0);
  writeFileSync(sign(p, "go"), "");
  const r = await running;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\nRun finished: 2 sessions, \$0\.50\.\n  #(7|9) landed on main in [0-9a-f]+\n  #(7|9) landed on main in [0-9a-f]+\nStopped at the owner's request\.\n/);
  assert.deepEqual(p.state().issues.map((i) => [i.number, i.state, i.assignees]), [[7, "closed", ["owner"]], [9, "closed", ["owner"]], [11, "open", []]]);
  assert.equal(p.claudeCalls().length, 2);
});

test("run --parallel 2 --dry-run names the two Tickets it would start, and claims nothing", (t) => {
  const p = runProject(t, [ready(7, { labels: ["ready-for-agent", "tier:hard"] }), ready(9), ready(11)], []);

  const r = p.run("run", "--parallel", "2", "--dry-run");

  assert.equal(
    r.stdout,
    "Ready: #7 Ticket 7 (hard), #9 Ticket 9 (standard), #11 Ticket 11 (standard).\n" +
      "Next: #7, on the hard Tier (opus, high effort, $35 budget); #9, on the standard Tier (opus, medium effort, $25 budget).\n",
  );
  assert.equal(r.code, 0);
  assert.deepEqual(p.state().issues.map((i) => i.assignees), [[], [], []]);
});

test("run --parallel refuses anything but a positive whole number", (t) => {
  const p = runProject(t, [ready(7)], []);
  for (const value of ["0", "1.5", "two"]) {
    const r = p.run("run", "--parallel", value);
    assert.equal(r.stderr, `verkstad run: --parallel needs a positive whole number; usage: verkstad run [--max <n>] [--parallel <n>] [--budget <usd>] [--dry-run] | verkstad run --ticket <n> [--budget <usd>] [--dry-run] | verkstad run --stop | verkstad run --abort\n`);
    assert.equal(r.code, 2);
  }
});

/** The Run's claims (`#7 Ticket 7`) and Landings (`#7 landed on main.`) in its output, in order. */
function claimsAndLandings(stdout: string): string[] {
  return stdout
    .split("\n")
    .filter((l) => l.startsWith("#") && (l.includes(": claimed") || l.includes(" landed on main in ")))
    .map((l) => l.replace(/ in [0-9a-f]+\.$/, ".").replace(/:.*/, ""));
}

test("run without --parallel works two of three ready Tickets side by side, and claims the third when one ends", (t) => {
  // #9 works on until #7 has landed and #11 has started, so that #11 starts while #9 is in flight.
  const eleven: StubSession = { ticket: 11, run: [`touch "$TMPDIR/started-11"`, ...(implemented(11, "c.txt").run ?? [])], report: report("done") };
  const p = runProject(t, [ready(7), ready(9), ready(11)], [besides(7, 9, "a.txt", "seven"), besides(9, 7, "b.txt", "nine", [afterLanding(7), meets(9, 11)]), eleven]);

  const r = p.run("run");

  assert.equal(r.stderr, "");
  assert.equal(r.code, 0);
  assert.deepEqual(
    claimsAndLandings(r.stdout).slice(0, 4),
    ["#7 Ticket 7", "#9 Ticket 9", "#7 landed on main.", "#11 Ticket 11"],
  );
  assert.deepEqual(p.state().issues.map((i) => [i.number, i.state]), [[7, "closed"], [9, "closed"], [11, "closed"]]);
  assert.ok(promptIn(p, 11).includes("Other agents are implementing these Tickets at the same time, each in a worktree of its own: #9 Ticket 9."), promptIn(p, 11));
});

test("run in a Project whose Contract caps parallel at 1 works one Ticket at a time", (t) => {
  const p = runProject(t, [ready(7), ready(9)], [implemented(7, "a.txt"), implemented(9, "b.txt")], { parallel: 1 });

  const r = p.run("run");

  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(
    claimsAndLandings(r.stdout),
    ["#7 Ticket 7", "#7 landed on main.", "#9 Ticket 9", "#9 landed on main."],
  );
  assert.ok(!promptIn(p, 7).includes("Other agents are implementing"), promptIn(p, 7));
});

test("run --parallel above the Contract's cap is a usage error naming the cap, and claims nothing", (t) => {
  const p = runProject(t, [ready(7), ready(9), ready(11)], [], { parallel: 2 });

  const r = p.run("run", "--parallel", "3");

  assert.equal(r.stderr, "verkstad run: --parallel 3 is above this Project's cap of 2 (`parallel` in .claude/harness.json)\n");
  assert.equal(r.code, 2);
  assert.deepEqual(p.state().issues.map((i) => i.assignees), [[], [], []]);
  assert.equal(p.claudeCalls().length, 0);
});

test("run refuses a Contract whose parallel is not a whole number of at least 1", (t) => {
  for (const parallel of [0, "two", 1.5]) {
    const p = runProject(t, [ready(7)], [], { parallel });

    const r = p.run("run");

    assert.equal(r.stderr, "verkstad run: .claude/harness.json: parallel must be a whole number of at least 1\n");
    assert.equal(r.code, 1);
    assert.deepEqual(p.state().issues.map((i) => i.assignees), [[]]);
  }
});

test("run --dry-run without --parallel names the two Tickets it would start", (t) => {
  const p = runProject(t, [ready(7), ready(9), ready(11)], []);

  const r = p.run("run", "--dry-run");

  assert.equal(
    r.stdout,
    "Ready: #7 Ticket 7 (standard), #9 Ticket 9 (standard), #11 Ticket 11 (standard).\n" +
      "Next: #7, on the standard Tier (opus, medium effort, $25 budget); #9, on the standard Tier (opus, medium effort, $25 budget).\n",
  );
  assert.equal(r.code, 0);
  assert.deepEqual(p.state().issues.map((i) => i.assignees), [[], [], []]);
});

test("run --parallel 2 stopped by one Ticket's failed session lets the other in flight land first, and logs what failed", (t) => {
  const failing: StubSession = { ticket: 7, run: [meets(7, 9)], subtype: "error_during_execution" };
  const p = runProject(t, [ready(7), ready(9), ready(11)], [failing, besides(9, 7, "b.txt", "nine")]);

  const r = p.run("run", "--parallel", "2");

  assert.equal(r.code, 1);
  assert.match(r.stderr, /^verkstad run: #7's implementing session failed \(error_during_execution\) without a report; /);
  assert.match(r.stdout, /\nRun stopped: 2 sessions, \$0\.50\.\n  #9 landed on main in [0-9a-f]+\nSomething for \/verkstad:reflect to learn from: #7 stopped the Run\.\n$/);
  assert.deepEqual(p.state().issues.map((i) => [i.number, i.state, i.assignees]), [[7, "open", ["owner"]], [9, "closed", ["owner"]], [11, "open", []]]);
  assert.deepEqual(eventLog(p).filter((e) => "failed" in e).map((e) => [e.ticket, String(e.failed).split(";")[0]]), [[7, "#7's implementing session failed (error_during_execution) without a report"]]);
});

/** Ticket #n's implementer, which starts once #m's has, commits `path`, pushes its branch and then works until it is killed. */
function killedBesides(n: number, m: number, path: string): StubSession {
  return besides(n, m, path, "half", [`git push -q origin issue-${n}`, `echo $$ > "$TMPDIR/pid-${n}"; until [ -e "$TMPDIR/never" ]; do sleep 0.1; done`]);
}

test("run --abort while two implementers are running kills both sessions and discards both Tickets' worktrees and branches, here and on origin", async (t) => {
  const p = runProject(t, [ready(7), ready(9), ready(11)], [killedBesides(7, 9, "a.txt"), killedBesides(9, 7, "b.txt"), implemented(11, "c.txt")]);
  const running = p.start(p.dir, "run", "--parallel", "2");
  await waitFor("both implementers to push", () => existsSync(sign(p, "pid-7")) && existsSync(sign(p, "pid-9")));
  const pids = [7, 9].map((n) => Number(readFileSync(sign(p, `pid-${n}`), "utf8")));
  assert.ok(pids.every(isAlive));

  const s = p.run("run", "--abort");

  assert.equal(s.stderr, "");
  assert.equal(s.stdout, "The Run aborts #7 and #9 and discards their work.\n");
  const r = await running;
  assert.equal(r.stderr, "");
  assert.equal(r.code, 0);
  assert.ok(!pids.some(isAlive));
  const discarded = (n: number) => `#${n}'s work was discarded: the worktree .claude/worktrees/issue-${n}, the branch issue-${n}, issue-${n} on origin, its review record.`;
  assert.equal(
    r.stdout,
    [
      "#7 Ticket 7: claimed, standard Tier (opus, medium effort, $25 budget).",
      "#7 implementing in .claude/worktrees/issue-7.",
      "#9 Ticket 9: claimed, standard Tier (opus, medium effort, $25 budget).",
      "#9 implementing in .claude/worktrees/issue-9.",
      "Run aborted: 2 sessions, $0.00.",
      `Aborted at the owner's request: ${discarded(7)} ${discarded(9)}`,
      CLEAN,
      "",
    ].join("\n"),
  );
  for (const n of [7, 9]) {
    assert.equal(existsSync(join(p.dir, ".claude", "worktrees", `issue-${n}`)), false);
    assert.equal(p.git("branch", "--list", `issue-${n}`), "");
    assert.equal(p.git("--git-dir", p.origin, "branch", "--list", `issue-${n}`), "");
  }
  assert.deepEqual(p.state().issues.map((i) => [i.number, i.state, i.assignees, i.comments.length]), [[7, "open", [], 1], [9, "open", [], 1], [11, "open", [], 0]]);
  assert.equal(p.claudeCalls().length, 2);
});

test("run --abort while one Ticket is landing and another is implementing lands the first and discards the second", async (t) => {
  const landing = 'touch "$TMPDIR/landing"; while [ ! -e "$TMPDIR/go" ]; do sleep 0.1; done';
  const p = runProject(t, [ready(7), ready(9)], [besides(7, 9, "a.txt", "seven"), killedBesides(9, 7, "b.txt")], {
    gate: { steps: [{ name: "slow", command: landing }] },
  });
  const running = p.start(p.dir, "run", "--parallel", "2");
  await waitFor("#7's Landing and #9's implementer", () => existsSync(sign(p, "landing")) && existsSync(sign(p, "pid-9")));
  const pid = Number(readFileSync(sign(p, "pid-9"), "utf8"));

  const s = p.run("run", "--abort");

  assert.equal(s.code, 0, s.stderr);
  assert.ok(isAlive(pid), "#9's implementer runs on while #7 lands");
  writeFileSync(sign(p, "go"), "");
  const r = await running;
  const sha = originSha(p);
  assert.equal(r.stderr, "");
  assert.equal(r.code, 0);
  assert.match(
    r.stdout,
    new RegExp(
      `\\n#7 landed on main in ${sha}\\.\\nRun aborted: 2 sessions, \\$0\\.25\\.\\n  #7 landed on main in ${sha}\\n` +
        "Aborted at the owner's request: #9's work was discarded: the worktree \\.claude/worktrees/issue-9, the branch issue-9, issue-9 on origin, its review record\\.\\n",
    ),
  );
  assert.equal(p.git("--git-dir", p.origin, "log", "--format=%s", "-1", "main"), "Adds a.txt. Refs #7");
  assert.ok(!isAlive(pid));
  assert.equal(existsSync(join(p.dir, ".claude", "worktrees", "issue-9")), false);
  assert.equal(p.git("branch", "--list", "issue-9"), "");
  assert.equal(p.git("--git-dir", p.origin, "branch", "--list", "issue-9"), "");
  assert.deepEqual(p.state().issues.map((i) => [i.number, i.state, i.assignees]), [[7, "closed", ["owner"]], [9, "open", []]]);
  const events = eventLog(p).map(({ at: _, ...e }) => e);
  assert.deepEqual(events.filter((e) => "verkstad" in e).map((e) => [e.ticket, (e.verkstad as string[])[0]]), [[7, "land"]]);
  assert.deepEqual(events.filter((e) => "aborted" in e).map((e) => e.ticket), [9]);
});

test("run --parallel 2 stopped by a new Surface in a Project with no Verify skill lets the other Ticket in flight land first", (t) => {
  const surfacing = besides(7, 9, "cli.txt", "cli");
  surfacing.report = report("done", { new_surfaces: [CLI_SURFACE] });
  const p = runProject(t, [ready(7), ready(9), ready(11)], [surfacing, besides(9, 7, "b.txt", "nine", [afterLanding(7)]), implemented(11, "c.txt")]);

  const r = p.run("run", "--parallel", "2");

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\n#7 added a Surface the Contract lacks: cli \(the first CLI command and what it prints\)\. Stopping: /);
  assert.match(r.stdout, /\nRun finished: 2 sessions, \$0\.50\.\n  #7 landed on main in [0-9a-f]+\n  #9 landed on main in [0-9a-f]+\n/);
  assert.deepEqual(p.state().issues.map((i) => [i.number, i.state]), [[7, "closed"], [9, "closed"], [11, "open"]]);
});

test("run --ticket 9 claims #9 before the lower #7, lands it and ends without claiming another; the event log names only #9", (t) => {
  const p = runProject(t, [ready(7), ready(9, { labels: ["ready-for-agent", "tier:light"] })], [implemented(9, "b.txt")]);

  const r = p.run("run", "--ticket", "9");

  const sha = originSha(p);
  assert.equal(r.stderr, "");
  assert.equal(
    r.stdout,
    [
      "#9 Ticket 9: claimed, light Tier (sonnet, medium effort, $5 budget).",
      "#9 implementing in .claude/worktrees/issue-9.",
      "#9 implementer reported done ($0.25).",
      "#9 touches no Surface; landing.",
      `#9 landed on main in ${sha}.`,
      "Run finished: 1 session, $0.25.",
      `  #9 landed on main in ${sha}`,
      CLEAN,
      "",
    ].join("\n"),
  );
  assert.equal(r.code, 0);
  assert.deepEqual(p.state().issues.map((i) => [i.number, i.state, i.assignees]), [[7, "open", []], [9, "closed", ["owner"]]]);
  assert.equal(p.claudeCalls().length, 1);
  const events = eventLog(p);
  assert.deepEqual(events[0].ready, [9]);
  assert.deepEqual([...new Set(events.filter((e) => "ticket" in e).map((e) => e.ticket))], [9]);
});

test("run --ticket Parks the chosen Ticket when its implementer reports blocked, and claims no other", (t) => {
  const blocked: StubSession = { run: ["verkstad start 9"], report: report("blocked", { uncertain: ["Which port? I would pick 8080."] }) };
  const p = runProject(t, [ready(7), ready(9)], [blocked]);

  const r = p.run("run", "--ticket", "9");

  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(claimsAndLandings(r.stdout), ["#9 Ticket 9"]);
  assert.match(r.stdout, /\nRun finished: 1 session, \$0\.25\.\n  #9 parked: blocked: Which port\? I would pick 8080\.\n/);
  assert.deepEqual(p.state().issues[0].assignees, []);
  assert.equal(p.claudeCalls().length, 1);
});

test("run --ticket refuses a Ticket that is not ready, and any while a Run is going, with exit code 1, claiming nothing", (t) => {
  const p = runProject(
    t,
    [
      ready(7),
      ready(8),
      ready(9, { blockedBy: [7, 8] }),
      ready(10, { labels: [] }),
      ready(11, { assignees: ["owner"] }),
      ready(12),
      ready(13, { parent: 12 }),
    ],
    [],
  );
  const refused = (n: number, message: string) => {
    for (const extra of [[], ["--dry-run"]]) {
      const r = p.run("run", "--ticket", String(n), ...extra);
      assert.equal(r.stdout, "");
      assert.equal(r.stderr, `verkstad run: ${message}\n`);
      assert.equal(r.code, 1);
    }
  };

  refused(9, "#9 waits on #7 and #8; it can start once they are closed");
  refused(10, "#10 is not an open issue labelled ready-for-agent");
  refused(11, "#11 is already claimed by @owner");
  refused(12, "#12 is a Spec, with sub-issues; choose one of its Tickets");

  const dir = join(p.dir, ".claude", "verkstad");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run-2026-10-08T10-00-00-000Z.jsonl"), '{"run":"started","pid":' + process.pid + "}\n");
  refused(7, "a Run is going; start #7 when it has ended");

  assert.deepEqual(p.state().issues.map((i) => [i.number, i.assignees]), [[7, []], [8, []], [9, []], [10, []], [11, ["owner"]], [12, []], [13, []]]);
  assert.deepEqual(p.claudeCalls(), []);
});

test("run --ticket --dry-run names the chosen Ticket and the Tier it would run on, and claims nothing", (t) => {
  const p = runProject(t, [ready(7), ready(9, { labels: ["ready-for-agent", "tier:hard"] })], []);

  const r = p.run("run", "--ticket", "9", "--dry-run");

  assert.equal(r.stderr, "");
  assert.equal(r.stdout, "Ticket: #9 Ticket 9 (hard).\nNext: #9, on the hard Tier (opus, high effort, $35 budget).\n");
  assert.equal(r.code, 0);
  assert.deepEqual(p.state().issues.map((i) => i.assignees), [[], []]);
  assert.equal(existsSync(join(p.dir, ".claude", "verkstad")) && readdirSync(join(p.dir, ".claude", "verkstad")).some((e) => e.startsWith("run-")), false);
});

test("run --ticket needs a positive whole number and goes with neither --max nor --parallel", (t) => {
  const p = runProject(t, [ready(7)], []);
  const usage =
    "usage: verkstad run [--max <n>] [--parallel <n>] [--budget <usd>] [--dry-run] | verkstad run --ticket <n> [--budget <usd>] [--dry-run] | " +
    "verkstad run --stop | verkstad run --abort";
  const refused: Array<[string[], string]> = [
    [["--ticket", "seven"], "--ticket needs a positive whole number"],
    [["--ticket", "7", "--max", "1"], "--ticket runs one Ticket; it takes neither --max nor --parallel"],
    [["--ticket", "7", "--parallel", "2"], "--ticket runs one Ticket; it takes neither --max nor --parallel"],
  ];
  for (const [args, message] of refused) {
    const r = p.run("run", ...args);
    assert.equal(r.stderr, `verkstad run: ${message}; ${usage}\n`);
    assert.equal(r.code, 2);
  }
  assert.deepEqual(p.state().issues[0].assignees, []);
});

/** Seconds since the epoch, `ahead` seconds from now: far enough that the Run is refused before then. */
function inSeconds(ahead: number): number {
  return Math.floor(Date.now() / 1000) + ahead;
}

/** A time in seconds since the epoch, as a Run names it. */
function utc(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

test("run waits until a rate limit that refused its claim resets, as GitHub reports it, then claims the Ticket and lands it", (t) => {
  const reset = inSeconds(4);
  const p = project(t, {
    issues: [ready(7)],
    sessions: [implemented(7, "a.txt")],
    contract: contract(),
    files: { ".gitignore": GITIGNORE },
    rateLimit: { command: "issue edit", resource: "core", reset, refusals: 1 },
  });

  const r = p.run("run");

  assert.equal(r.code, 0, r.stderr);
  assert.ok(Date.now() >= reset * 1000, "the Run tried the call again before the limit reset");
  const lines = r.stdout.split("\n");
  assert.equal(lines[0], `GitHub's rate limit refused gh issue edit; waiting until ${utc(reset)}, then trying it once more.`);
  assert.equal(lines[1], "#7 Ticket 7: claimed, standard Tier (opus, medium effort, $25 budget).");
  assert.match(r.stdout, /\n {2}#7 landed on main in [0-9a-f]+\n/);
  const issue = p.state().issues[0];
  assert.equal(issue.state, "closed");
  assert.deepEqual(issue.assignees, ["owner"]);
  const claims = p.calls().filter((c) => c[0] === "issue" && c[1] === "edit" || c.join(" ") === "api rate_limit");
  assert.deepEqual(claims, [
    ["issue", "edit", "7", "--add-assignee", "@me"],
    ["api", "rate_limit"],
    ["issue", "edit", "7", "--add-assignee", "@me"],
  ]);
  assert.deepEqual(
    eventLog(p).filter((e) => "waiting" in e).map(({ waiting, refused }) => ({ waiting, refused })),
    [{ waiting: utc(reset), refused: "gh issue edit" }],
  );
});

test("run ends with the refusal as its reason when GitHub refuses the call again after the wait", (t) => {
  const reset = inSeconds(4);
  const p = project(t, {
    issues: [ready(7)],
    sessions: [implemented(7, "a.txt")],
    contract: contract(),
    files: { ".gitignore": GITIGNORE },
    rateLimit: { command: "issue edit", resource: "core", reset, refusals: 2 },
  });

  const r = p.run("run");

  assert.equal(r.code, 1);
  assert.equal(r.stderr, "verkstad run: gh issue edit failed: gh: API rate limit exceeded for user ID 1. (HTTP 403)\n");
  assert.equal(
    r.stdout,
    `GitHub's rate limit refused gh issue edit; waiting until ${utc(reset)}, then trying it once more.\n` +
      "Run stopped: 0 sessions, $0.00.\nSomething for /verkstad:reflect to learn from: #7 stopped the Run.\n",
  );
  assert.deepEqual(p.claudeCalls(), []);
  assert.equal(eventLog(p).at(-1)?.run, "stopped");
});

test("run closes a Ticket whose Landing pushed but was refused its close for a rate limit, with Landing's comment, once the limit lifts", (t) => {
  const reset = inSeconds(6);
  const p = project(t, {
    issues: [ready(7)],
    sessions: [implemented(7, "a.txt")],
    contract: contract(),
    files: { ".gitignore": GITIGNORE },
    // Landing's close, and the Run's first.
    rateLimit: { command: "issue close", resource: "graphql", reset, refusals: 2 },
  });

  const r = p.run("run");

  assert.equal(r.code, 0, r.stderr);
  const sha = originSha(p);
  assert.match(
    r.stdout,
    new RegExp(
      "\\n#7 Landing failed: github-failed\\.\\n" +
        `GitHub's rate limit refused gh issue close; waiting until ${utc(reset)}, then trying it once more\\.\\n` +
        `#7 landed on main in ${sha}; the Run closed it after GitHub refused Landing's close\\.\\n` +
        "Run finished: 1 session, \\$0\\.25\\.\\n" +
        `  #7 landed on main in ${sha}; the Run closed it after GitHub refused Landing's close\\n` +
        "Something for /verkstad:reflect to learn from: #7 Landing failed \\(github-failed\\)\\.\\n$",
    ),
  );
  assert.ok(Date.now() >= reset * 1000);
  const issue = p.state().issues[0];
  assert.equal(issue.state, "closed");
  assert.equal(issue.comments.length, 1);
  assert.match(issue.comments[0].body, new RegExp(`^Landed on main in ${sha}\\.\\n\\nstatus: done\\nWhat was built: the feature\\.\\n`));
  assert.match(issue.comments[0].body, /Verification state: test-verified\./);
  assert.deepEqual(readdirSync(join(p.dir, ".claude", "verkstad")).filter((e) => e.startsWith("close-")), []);
  assert.deepEqual(eventLog(p).filter((e) => e.ticket === 7 && "landed" in e).map((e) => [e.landed, e.commit]), [
    [`landed on main in ${sha}; the Run closed it after GitHub refused Landing's close`, sha],
  ]);
});

test("run closes with a note, and does not claim, a ready Ticket whose commits are already on the base branch", (t) => {
  const p = runProject(t, [ready(7), ready(9)], [implemented(9, "b.txt")]);
  for (const [path, message] of [["a.txt", "Adds a.txt. Refs #7"], ["c.txt", "Adds c.txt. Refs #97"]]) {
    writeFileSync(join(p.dir, path), "landed\n");
    p.git("add", path);
    p.git("commit", "--quiet", "-m", message);
  }
  p.git("push", "--quiet", "origin", "main");
  const landed = p.git("rev-parse", "--short", "HEAD~1");

  const r = p.run("run");

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^#7 Ticket 7: already landed on main in ${landed} \\(Adds a\\.txt\\. Refs #7\\); closed, not claimed\\.\\n#9 Ticket 9: claimed, `));
  assert.match(r.stdout, new RegExp(`\\nRun finished: 1 session, \\$0\\.25\\.\\n  #7 already landed on main in ${landed}; closed, not claimed\\n  #9 landed on main in [0-9a-f]+\\nThe Run was clean: `));
  const [seven, nine] = p.state().issues;
  assert.equal(seven.state, "closed");
  assert.deepEqual(seven.assignees, []);
  assert.deepEqual(seven.comments.map((c) => c.body), [
    `Already landed on main in ${landed} (Adds a.txt. Refs #7), so verkstad run closed it instead of claiming it.`,
  ]);
  assert.equal(nine.state, "closed");
  assert.deepEqual(p.calls().filter((c) => c[1] === "edit").map((c) => c[2]), ["9"]);
  assert.equal(p.claudeCalls().length, 1);
});
