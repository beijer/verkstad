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

  for (const edit of otherHeredocEdits) {
    const command = edit + "\nGIT_PAGER=cat true";
    const r = p.pipe(wt, bashEvent(wt, command), "hook", "pre-tool-use");

    assert.equal(r.stderr, "", command);
    assert.equal(r.code, 0, command);
    assert.equal(r.stdout, refusal, command);
  }
});

test("in an agent worktree, the hook lets a heredoc edit whose text does not mention git through", (t) => {
  const p = project(t);
  const wt = agentWorktree(p);
  const plainPython = "python3 - <<'EOF'\nopen('a.txt', 'w').write('x')\nEOF";
  const commands = [
    plainPython,
    "cat > /tmp/x.py <<EOF\nprint(1)\nEOF",
    "node - <<'EOF'\nconsole.log(1)\nEOF",
    ...otherHeredocEdits.slice(2).map((c) => c.replace(/git/g, "it")),
  ];

  for (const command of commands) {
    const r = p.pipe(wt, bashEvent(wt, command), "hook", "pre-tool-use");

    assert.deepEqual(r, { code: 0, stdout: "", stderr: "" }, command);
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

test("in the main checkout, the hook lets a heredoc without git in its text through", (t) => {
  const p = project(t);
  agentWorktree(p);

  const command = "cat > /tmp/x.py <<EOF\nprint(1)\nEOF";
  const r = p.pipe(p.dir, bashEvent(p.dir, command), "hook", "pre-tool-use");

  assert.deepEqual(r, { code: 0, stdout: "", stderr: "" });
});

test("in an agent worktree, git counts when it starts a word, as in .gitignore, and not inside one, as in digit", (t) => {
  const p = project(t);
  const wt = agentWorktree(p);

  const refused = p.pipe(wt, bashEvent(wt, "cat > .gitignore <<EOF\nx\nEOF"), "hook", "pre-tool-use");
  const passed = p.pipe(wt, bashEvent(wt, "cat > /tmp/digit.txt <<EOF\nx\nEOF"), "hook", "pre-tool-use");

  assert.equal(JSON.parse(refused.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(passed, { code: 0, stdout: "", stderr: "" });
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

/** Runs the hook on a Bash command in `cwd`, with `SHELL` set to `shell`, or unset when it is undefined. */
function hookUnder(p: Project, shell: string | undefined, cwd: string, command: string) {
  const bin = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "verkstad");
  const env = { ...p.env, ...(shell === undefined ? {} : { SHELL: shell }) };
  const r = spawnSync(bin, ["hook", "pre-tool-use"], { cwd, env, input: bashEvent(cwd, command), encoding: "utf8" });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

function zshRefusal(word: string, quoted: string): string {
  const reason =
    "verkstad: zsh, the shell here, expands an unquoted word that starts with = as the path of a command " +
    `and abandons the rest of the command line when there is none, so ${word} would fail; quote it: ${quoted}`;
  const decision = { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason };
  return JSON.stringify({ hookSpecificOutput: decision }) + "\n";
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

test("under zsh, the heredoc refusal is unchanged: an agent worktree refuses it, the main checkout lets it through", (t) => {
  const p = project(t);
  const wt = agentWorktree(p);

  assert.deepEqual(hookUnder(p, "/usr/bin/zsh", wt, pythonEdit), { code: 0, stdout: refusal, stderr: "" });
  assert.deepEqual(hookUnder(p, "/usr/bin/zsh", p.dir, pythonEdit), { code: 0, stdout: "", stderr: "" });
});
