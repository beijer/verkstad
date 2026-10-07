import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { project, type Project } from "./project.ts";

/** An agent worktree as Claude Code makes one, switched to `branch` off main, with `commits` commits on it. */
function agentWorktree(p: Project, branch: string, commits = 1): string {
  const wt = join(p.dir, "..", "agent-a");
  p.git("worktree", "add", "--quiet", "-b", branch, wt, "main");
  for (let i = 1; i <= commits; i++) {
    writeFileSync(join(wt, `feature-${i}.txt`), "a feature\n");
    p.git("-C", wt, "add", `feature-${i}.txt`);
    p.git("-C", wt, "commit", "--quiet", "-m", `Adds feature ${i}`);
  }
  return realpathSync(wt);
}

/** The SubagentStop event Claude Code sends a hook when an agent of type `agentType` in `cwd` is about to stop. */
function stopEvent(cwd: string, agentType = "verkstad:ticket-standard", active = false): string {
  return JSON.stringify({
    session_id: "abc123",
    transcript_path: "/tmp/transcript.jsonl",
    cwd,
    permission_mode: "default",
    hook_event_name: "SubagentStop",
    stop_hook_active: active,
    agent_id: "agent-a",
    agent_type: agentType,
    agent_transcript_path: "/tmp/agent-a.jsonl",
    last_assistant_message: "status: done",
  });
}

const block =
  JSON.stringify({
    decision: "block",
    reason:
      "verkstad: issue-7 has commits ahead of origin/main and no review of it is recorded, so Landing would refuse it " +
      "with review-missing. Before you hand back, run `git merge-base HEAD origin/main` on its own and review the branch " +
      "with Skill verkstad:review against the commit it prints; when both reviews are back, run `verkstad review record` " +
      "in this worktree. Then fix the real findings, run the Gate again and hand back.",
  }) + "\n";

const letStop = { code: 0, stdout: "", stderr: "" };

test("a Tier agent about to stop on issue-<n> with unreviewed commits is blocked and told to run verkstad:review and verkstad review record", (t) => {
  const p = project(t);
  const wt = agentWorktree(p, "issue-7", 2);

  const r = p.pipe(wt, stopEvent(wt), "hook", "subagent-stop");

  assert.equal(r.stderr, "");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, block);
});

test("every Tier blocks the stop, named with or without the plugin", (t) => {
  const p = project(t);
  const wt = agentWorktree(p, "issue-7");

  for (const tier of ["verkstad:ticket-light", "verkstad:ticket-hard", "ticket-standard"]) {
    const r = p.pipe(wt, stopEvent(wt, tier), "hook", "subagent-stop");

    assert.deepEqual(r, { code: 0, stdout: block, stderr: "" }, tier);
  }
});

test("with a review recorded for the branch, the hook lets the agent stop", (t) => {
  const p = project(t);
  const wt = agentWorktree(p, "issue-7");
  assert.equal(p.runIn(wt, "review", "record").code, 0);
  // A fix committed after the review keeps the record.
  writeFileSync(join(wt, "fix.txt"), "a fix\n");
  p.git("-C", wt, "add", "fix.txt");
  p.git("-C", wt, "commit", "--quiet", "-m", "Fixes a finding");

  const r = p.pipe(wt, stopEvent(wt), "hook", "subagent-stop");

  assert.deepEqual(r, letStop);
});

test("on a branch other than issue-<n>, the hook lets the agent stop", (t) => {
  const p = project(t);
  const wt = agentWorktree(p, "worktree-agent-a");

  const r = p.pipe(wt, stopEvent(wt), "hook", "subagent-stop");

  assert.deepEqual(r, letStop);
});

test("with no commits ahead of origin/<base>, the hook lets the agent stop", (t) => {
  const p = project(t);
  const wt = agentWorktree(p, "issue-7", 0);

  const r = p.pipe(wt, stopEvent(wt), "hook", "subagent-stop");

  assert.deepEqual(r, letStop);
});

test("outside an agent worktree, the hook lets the agent stop: in the main checkout on issue-<n>, and outside git", (t) => {
  const p = project(t);
  p.git("switch", "--quiet", "-c", "issue-7");
  writeFileSync(join(p.dir, "feature.txt"), "a feature\n");
  p.git("add", "feature.txt");
  p.git("commit", "--quiet", "-m", "Adds feature");
  const outside = realpathSync(join(p.dir, ".."));

  const main = p.pipe(p.dir, stopEvent(p.dir), "hook", "subagent-stop");
  const noGit = p.pipe(outside, stopEvent(outside), "hook", "subagent-stop");

  assert.deepEqual(main, letStop);
  assert.deepEqual(noGit, letStop);
});

test("a hook already continuing a blocked stop (stop_hook_active) lets the agent stop, so it cannot loop", (t) => {
  const p = project(t);
  const wt = agentWorktree(p, "issue-7");

  const r = p.pipe(wt, stopEvent(wt, "verkstad:ticket-standard", true), "hook", "subagent-stop");

  assert.deepEqual(r, letStop);
});

test("an agent that is not a Tier agent, such as the Verifier or an Explore search, is let stop in the same worktree", (t) => {
  const p = project(t);
  const wt = agentWorktree(p, "issue-7");

  for (const type of ["verkstad:verifier", "Explore", "general-purpose"]) {
    const r = p.pipe(wt, stopEvent(wt, type), "hook", "subagent-stop");

    assert.deepEqual(r, letStop, type);
  }
});

test("a stdin that is not a hook event fails with exit 1, never 2, which would block the stop", (t) => {
  const p = project(t);
  const wt = agentWorktree(p, "issue-7");

  const r = p.pipe(wt, "not json", "hook", "subagent-stop");

  assert.deepEqual(r, { code: 1, stdout: "", stderr: "verkstad hook: stdin is not a SubagentStop event as JSON\n" });
});

test("the plugin's hooks/hooks.json runs the hook on SubagentStop, so that Claude Code blocks the stop", (t) => {
  const p = project(t);
  const wt = agentWorktree(p, "issue-7");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const config = JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf8")) as {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>>;
  };
  const handlers = config.hooks.SubagentStop.flatMap((entry) => entry.hooks);
  assert.equal(handlers.length, 1);
  assert.equal(handlers[0].type, "command");

  // Claude Code runs a shell-form command through a shell, with ${CLAUDE_PLUGIN_ROOT} set to the plugin's root.
  const r = spawnSync("sh", ["-c", handlers[0].command], {
    cwd: wt,
    env: { ...p.env, CLAUDE_PLUGIN_ROOT: root },
    input: stopEvent(wt),
    encoding: "utf8",
  });

  assert.equal(r.stderr, "");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, block);
});
