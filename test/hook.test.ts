import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { project, type Project } from "./project.ts";

/** An agent worktree as Claude Code makes one: on a branch of its own, beside the main checkout. */
function agentWorktree(p: Project): string {
  const wt = join(p.dir, "..", "agent-a");
  p.git("worktree", "add", "--quiet", "-b", "worktree-agent-a", wt, "main");
  return realpathSync(wt);
}

/** The PreToolUse event Claude Code sends a hook for a Bash command run in `cwd`. */
function bashEvent(cwd: string, command: string): string {
  return JSON.stringify({
    session_id: "abc123",
    transcript_path: "/tmp/transcript.jsonl",
    cwd,
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command, description: "Edit a file" },
    tool_use_id: "toolu_01",
  });
}

const reason =
  "verkstad: in an agent worktree, change a file with the Edit tool and create one with the Write tool, " +
  "not with a heredoc fed to python3 -, node - or cat >: Claude Code's worktree guard refuses such a command " +
  "when its text mentions git.";

const refusal =
  JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  }) + "\n";

const pythonEdit = [
  "python3 - <<'EOF'",
  "p = 'test/land.test.ts'",
  "s = open(p).read()",
  "s = s.replace('git push', 'git push --quiet')",
  "open(p, 'w').write(s)",
  "EOF",
].join("\n");

test("in an agent worktree, the hook refuses a heredoc fed to python3 - and names the Edit and Write tools", (t) => {
  const p = project(t);
  const wt = agentWorktree(p);

  const r = p.pipe(wt, bashEvent(wt, pythonEdit), "hook", "pre-tool-use");

  assert.equal(r.stderr, "");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, refusal);
});

const otherHeredocEdits = [
  "node - <<'EOF'\nconst fs = require('node:fs');\nfs.writeFileSync('a.ts', 'git');\nEOF",
  "cat > src/new.ts <<'EOF'\nexport const git = 1;\nEOF",
  'cat <<"EOF" >> notes.md\nmore\nEOF',
  "cd src && python3 - a.ts <<EOF\nprint(1)\nEOF",
  "cat >test/a.test.ts <<-EOF\n\tgit status\n\tEOF\nnpm test",
  "echo $((1<<2))\ncat > f <<EOF\nx\nEOF",
  "cat <<EOF &> f\nx\nEOF",
  "env A=1 python3 - <<EOF\nx\nEOF",
  "if true; then cat > f <<EOF\nx\nEOF\nfi",
  "echo $'it\\'s'; cat > f <<EOF\nx\nEOF",
  "cat <<EOF >&f\nx\nEOF",
];

test("in an agent worktree, the hook refuses a heredoc fed to node - or cat >, wherever it sits in the command", (t) => {
  const p = project(t);
  const wt = agentWorktree(p);

  for (const command of otherHeredocEdits) {
    const r = p.pipe(wt, bashEvent(wt, command), "hook", "pre-tool-use");

    assert.equal(r.stderr, "", command);
    assert.equal(r.code, 0, command);
    assert.equal(r.stdout, refusal, command);
  }
});

test("in the main checkout, the hook lets a heredoc fed to python3 -, node - or cat > through", (t) => {
  const p = project(t);
  agentWorktree(p);
  const sub = join(p.dir, "docs");

  for (const [cwd, command] of [[p.dir, pythonEdit], [p.dir, otherHeredocEdits[0]], [sub, otherHeredocEdits[1]]]) {
    const r = p.pipe(cwd, bashEvent(cwd, command), "hook", "pre-tool-use");

    assert.deepEqual(r, { code: 0, stdout: "", stderr: "" }, command);
  }
});

test("in a submodule's checkout, which is no worktree, the hook lets a heredoc edit through", (t) => {
  const p = project(t);
  p.git("-c", "protocol.file.allow=always", "submodule", "add", "--quiet", p.origin, "sub");
  const sub = realpathSync(join(p.dir, "sub"));

  const r = p.pipe(sub, bashEvent(sub, pythonEdit), "hook", "pre-tool-use");

  assert.deepEqual(r, { code: 0, stdout: "", stderr: "" });
});

test("outside a git checkout, the hook lets a heredoc edit through", (t) => {
  const p = project(t);
  const outside = realpathSync(join(p.dir, ".."));

  const r = p.pipe(outside, bashEvent(outside, pythonEdit), "hook", "pre-tool-use");

  assert.deepEqual(r, { code: 0, stdout: "", stderr: "" });
});

test("in an agent worktree, the hook lets a Bash command without such a heredoc through", (t) => {
  const p = project(t);
  const wt = agentWorktree(p);
  const commands = [
    "git status",
    "npm test",
    "git commit -q -F - <<'EOF'\nA sentence. Refs #18\nEOF",
    "cat <<'EOF' | gh issue comment 18 --body-file -\nDone.\nEOF",
    "python3 -c 'print(1)' <<EOF\nx\nEOF",
    "node -e \"require('fs')\"",
    "cat src/hook.ts > /tmp/copy.ts",
    "grep -n \"python3 - <<'EOF'\" test/hook.test.ts",
    "echo 'cat > a <<EOF' # cat > b <<EOF",
    "wc -l <<<\"python3 - <<EOF\"",
    "gh issue create --title T --body-file - <<'EOF'\npython3 - <<'X'\ncat > f <<'Y'\nEOF",
    "cat <<EOF 2>/dev/null\nhi\nEOF",
    "cat <<EOF > /dev/null\nhi\nEOF",
    "cat <<EOF >&2\nhi\nEOF",
  ];

  for (const command of commands) {
    const r = p.pipe(wt, bashEvent(wt, command), "hook", "pre-tool-use");

    assert.deepEqual(r, { code: 0, stdout: "", stderr: "" }, command);
  }
});

test("the hook lets every tool but Bash through, even in an agent worktree", (t) => {
  const p = project(t);
  const wt = agentWorktree(p);
  const event = JSON.parse(bashEvent(wt, pythonEdit)) as Record<string, unknown>;
  event.tool_name = "Monitor";

  const r = p.pipe(wt, JSON.stringify(event), "hook", "pre-tool-use");

  assert.deepEqual(r, { code: 0, stdout: "", stderr: "" });
});

test("a stdin that is not a hook event fails with exit 1, which lets the call through, never 2, which would block it", (t) => {
  const p = project(t);
  const wt = agentWorktree(p);

  const r = p.pipe(wt, "not json", "hook", "pre-tool-use");

  assert.deepEqual(r, { code: 1, stdout: "", stderr: "verkstad hook: stdin is not a PreToolUse event as JSON\n" });
});

test("the plugin's hooks/hooks.json runs the hook on every Bash call, so that Claude Code gets its refusal", (t) => {
  const p = project(t);
  const wt = agentWorktree(p);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const config = JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf8")) as {
    hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>>;
  };
  const handlers = config.hooks.PreToolUse.filter((entry) => entry.matcher === "Bash").flatMap((entry) => entry.hooks);
  assert.equal(handlers.length, 1);
  assert.equal(handlers[0].type, "command");

  // Claude Code runs a shell-form command through a shell, with ${CLAUDE_PLUGIN_ROOT} set to the plugin's root.
  const r = spawnSync("sh", ["-c", handlers[0].command], {
    cwd: wt,
    env: { ...p.env, CLAUDE_PLUGIN_ROOT: root },
    input: bashEvent(wt, pythonEdit),
    encoding: "utf8",
  });

  assert.equal(r.stderr, "");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, refusal);
});

test("hook without its event, or with another, is a usage error", (t) => {
  const p = project(t);

  const none = p.pipe(p.dir, bashEvent(p.dir, pythonEdit), "hook");
  const other = p.pipe(p.dir, bashEvent(p.dir, pythonEdit), "hook", "post-tool-use");

  assert.deepEqual(none, { code: 2, stdout: "", stderr: "verkstad hook: needs the hook event; usage: verkstad hook pre-tool-use\n" });
  assert.deepEqual(other, {
    code: 2,
    stdout: "",
    stderr: "verkstad hook: no hook for 'post-tool-use'; usage: verkstad hook pre-tool-use\n",
  });
});
