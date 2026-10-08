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

const bin = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "verkstad");

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

const pythonEdit = [
  "python3 - <<'EOF'",
  "p = 'test/land.test.ts'",
  "s = open(p).read()",
  "s = s.replace('git push', 'git push --quiet')",
  "open(p, 'w').write(s)",
  "EOF",
].join("\n");

test("in an agent worktree and outside one, under zsh and bash, the hook lets a heredoc edit, a cd into the worktree and an expanded variable through", (t) => {
  const p = project(t);
  const wt = agentWorktree(p);
  const outside = realpathSync(join(p.dir, ".."));

  for (const cwd of [wt, p.dir, outside]) {
    const commands = [
      pythonEdit,
      "cat > src/new.ts <<'EOF'\nexport const git = 1;\nEOF",
      `cd ${cwd} && git status --short`,
      "cd packages/x && git log -1",
      "f=src/a.ts && sed -i s/a/b/ $f",
      'F=a.ts; grep git "$F"',
    ];
    for (const shell of ["/usr/bin/zsh", "/bin/bash"]) {
      for (const command of commands) {
        const r = hookUnder(p, shell, cwd, command);

        assert.deepEqual(r, { code: 0, stdout: "", stderr: "" }, `${command} under ${shell} in ${cwd}`);
      }
    }
  }
});

test("the hook lets every tool but Bash through, even in an agent worktree", (t) => {
  const p = project(t);
  const wt = agentWorktree(p);
  const event = JSON.parse(bashEvent(wt, "echo =====")) as Record<string, unknown>;
  event.tool_name = "Monitor";

  const r = spawnSync(bin, ["hook", "pre-tool-use"], {
    cwd: wt,
    env: { ...p.env, SHELL: "/usr/bin/zsh" },
    input: JSON.stringify(event),
    encoding: "utf8",
  });

  assert.deepEqual({ code: r.status, stdout: r.stdout, stderr: r.stderr }, { code: 0, stdout: "", stderr: "" });
});

test("a stdin that is not a hook event fails with exit 1, which lets the call through, never 2, which would block it", (t) => {
  const p = project(t);
  const wt = agentWorktree(p);

  const r = p.pipe(wt, "not json", "hook", "pre-tool-use");

  assert.deepEqual(r, { code: 1, stdout: "", stderr: "verkstad hook: stdin is not a PreToolUse event as JSON\n" });
});

test("the plugin's hooks are one PreToolUse hook on every Bash call, which Claude Code runs to get its refusal", (t) => {
  const p = project(t);
  const wt = agentWorktree(p);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const config = JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf8")) as {
    hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>>;
  };
  assert.deepEqual(Object.keys(config.hooks), ["PreToolUse"]);
  assert.equal(config.hooks.PreToolUse.length, 1);
  const handlers = config.hooks.PreToolUse.filter((entry) => entry.matcher === "Bash").flatMap((entry) => entry.hooks);
  assert.equal(handlers.length, 1);
  assert.equal(handlers[0].type, "command");

  // Claude Code runs a shell-form command through a shell, with ${CLAUDE_PLUGIN_ROOT} set to the plugin's root.
  const r = spawnSync("sh", ["-c", handlers[0].command], {
    cwd: wt,
    env: { ...p.env, CLAUDE_PLUGIN_ROOT: root, SHELL: "/usr/bin/zsh" },
    input: bashEvent(wt, "echo ====="),
    encoding: "utf8",
  });

  assert.equal(r.stderr, "");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, zshRefusal("=====", "'====='"));
});

test("hook without its event, or with another, subagent-stop included, is a usage error", (t) => {
  const p = project(t);

  const none = p.pipe(p.dir, bashEvent(p.dir, pythonEdit), "hook");
  const other = p.pipe(p.dir, bashEvent(p.dir, pythonEdit), "hook", "post-tool-use");
  const stop = p.pipe(p.dir, JSON.stringify({ hook_event_name: "SubagentStop", cwd: p.dir }), "hook", "subagent-stop");

  assert.deepEqual(none, {
    code: 2,
    stdout: "",
    stderr: "verkstad hook: needs the hook event; usage: verkstad hook pre-tool-use\n",
  });
  assert.deepEqual(other, {
    code: 2,
    stdout: "",
    stderr: "verkstad hook: no hook for 'post-tool-use'; usage: verkstad hook pre-tool-use\n",
  });
  assert.deepEqual(stop, {
    code: 2,
    stdout: "",
    stderr: "verkstad hook: no hook for 'subagent-stop'; usage: verkstad hook pre-tool-use\n",
  });
});

/** Runs the hook on a Bash command in `cwd`, with `SHELL` set to `shell`, or unset when it is undefined. */
function hookUnder(p: Project, shell: string | undefined, cwd: string, command: string) {
  const env = { ...p.env, ...(shell === undefined ? {} : { SHELL: shell }) };
  const r = spawnSync(bin, ["hook", "pre-tool-use"], { cwd, env, input: bashEvent(cwd, command), encoding: "utf8" });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

function zshRefusal(word: string, quoted: string): string {
  const reason =
    "verkstad: zsh, the shell here, expands an unquoted word that starts with = as the path of a command " +
    `and abandons the rest of the command line when there is none, so ${word} would fail; quote it: ${quoted}`;
  return denial(reason);
}

test("under zsh, the hook refuses a word that starts with = in the main checkout, in an agent worktree and outside git", (t) => {
  const p = project(t);
  const wt = agentWorktree(p);
  const outside = realpathSync(join(p.dir, ".."));

  for (const cwd of [p.dir, wt, outside]) {
    const r = hookUnder(p, "/usr/bin/zsh", cwd, "echo a; echo =====; echo b");

    assert.deepEqual(r, { code: 0, stdout: zshRefusal("=====", "'====='"), stderr: "" }, cwd);
  }
});

test("under zsh, the hook refuses an assignment whose value starts with =, and a test whose operator is ==", (t) => {
  const p = project(t);

  const cases: Array<[string, string, string]> = [
    ["a==b", "a==b", "a='=b'"],
    ["npm test && x==it\\'s", "x==it's", "x='=it'\\''s'"],
    ["[ a == b ] && echo same", "==", "'=='"],
    ["ls > =out", "=out", "'=out'"],
    ["echo $(echo =x)", "=x", "'=x'"],
    ["x=1 y==2 npm test", "y==2", "y='=2'"],
    ["export PAGER==less", "PAGER==less", "PAGER='=less'"],
    ["echo [[ =x", "=x", "'=x'"],
  ];
  for (const [command, word, quoted] of cases) {
    const r = hookUnder(p, "/bin/zsh", p.dir, command);

    assert.deepEqual(r, { code: 0, stdout: zshRefusal(word, quoted), stderr: "" }, command);
  }
});

test("under zsh, the hook lets a quoted =word, an assignment, an option and a [[ ]] test through", (t) => {
  const p = project(t);
  const commands = [
    "echo '====='",
    'echo "====="',
    "echo \\=====",
    "a=b",
    "x=1 npm test",
    "npm test -- --opt=value",
    "echo a==b",
    "pip install requests==2.31",
    "[[ x == y ]] && echo same",
    "if [[ $a == b || $a == c ]]; then echo yes; fi",
    "echo a = b",
    "echo $((1 == 1))",
    "cat <<'EOF'\n=====\nEOF",
    "gh issue comment 19 --body \"=== Done ===\"",
  ];

  for (const command of commands) {
    const r = hookUnder(p, "/usr/bin/zsh", p.dir, command);

    assert.deepEqual(r, { code: 0, stdout: "", stderr: "" }, command);
  }
});

test("under bash, or with SHELL unset, the hook lets a word that starts with = through", (t) => {
  const p = project(t);
  const wt = agentWorktree(p);

  for (const shell of ["/bin/bash", undefined]) {
    for (const cwd of [p.dir, wt]) {
      const r = hookUnder(p, shell, cwd, "echo =====");

      assert.deepEqual(r, { code: 0, stdout: "", stderr: "" }, `${shell} in ${cwd}`);
    }
  }
});

function denial(reason: string): string {
  const decision = { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason };
  return JSON.stringify({ hookSpecificOutput: decision }) + "\n";
}
