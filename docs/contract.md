# The Contract

What a Project tells verkstad about itself, in two files at fixed paths in the Project:

- `.claude/harness.json`: for the scripts, read by the `verkstad` CLI. JSON, described below.
- `docs/agents/project.md`: for the agents, in prose: what an agent must know to work in the Project (a PATH it needs, a rule such as never touching real hardware, a generated file it must regenerate). verkstad's prompts carry nothing about any one Project; this doc does.

Neither repeats the other. A fact a script acts on goes in `harness.json`; everything else goes in `project.md`.

## The log directory

`<main checkout>/.claude/verkstad/` holds what the CLI keeps: Gate logs, Verify logs, reports, Verdicts and Evidence. It is gitignored (a Project adds `.claude/verkstad/` to its `.gitignore`) and lies outside every worktree, so Landing, which removes a worktree, never removes what it holds. The CLI finds the main checkout from any worktree with `git rev-parse --path-format=absolute --git-common-dir`.

## What GitHub holds

Some of what the CLI needs lives on GitHub rather than in `harness.json`, and is the same in every Project:

- **The repo** is whichever one `gh repo view` resolves from the Project's checkout (its `origin`, or `GH_REPO`).
- **Specs and blockers** are native relations (ADR 0006): a Spec is an issue with sub-issues; a Ticket's blockers are its `blocked_by` dependencies. A Project that named them in issue text converts them once with `verkstad convert-links`: each open issue becomes a sub-issue of the first `#<n>` under its `## Parent` heading (or on a `Part of #<n>` line), and is blocked by every `#<n>` under its `## Blocked by` heading, except on a line saying `None`. Closed issues are left as they are; their links are history. A reference that is not an issue in the repo, or an issue that already has another parent, is reported and skipped.
- **Labels**: `ready-for-agent` puts a Ticket on the way to the Frontier. A blocker labelled `ready-for-human` or `needs-info` waits on the owner, and `verkstad frontier` marks it `[human]` or `[needs-info]`.

`verkstad frontier` reads only these; it needs no field of `harness.json`.

## `.claude/harness.json`

A JSON object. Each field is documented here by the Ticket that first gives it a reader in the CLI; until then a field's shape may still change.

| Field | Reader | Meaning |
| --- | --- | --- |
| `baseBranch` | `gate --quick`, `land` | The branch Tickets land on. |
| `gate` | `gate`, `land` | The Gate's named steps. |
| `landing` | `land` | The Landing mode: `push` or `pull-request`. |
| `surfaces` | `surfaces`, `verdict check` | The Surfaces, each a name and the path globs whose changes can alter it. `[]` for a Project with none. |
| `verify` | the Verifier | The name of the Project's Verify skill. |

### `baseBranch`

A string, required: the branch Tickets branch from and land on, e.g. `"main"`. `gate --quick` diffs against `git merge-base HEAD origin/<baseBranch>`, so a branch's changes are what it added since it left the base branch, whatever landed there since.

### `gate`

An object, required: the Gate that `verkstad gate` runs.

```json
"gate": {
  "env": { "PATH": "$HOME/.cargo/bin:$PATH", "CARGO_TARGET_DIR": null },
  "steps": [
    { "name": "install", "command": "pnpm install --frozen-lockfile", "unlessExists": "node_modules" },
    { "name": "unit tests", "command": "pnpm test" },
    {
      "name": "e2e tests",
      "command": "pnpm e2e",
      "quick": { "files": "e2e/*.e2e.ts", "env": "E2E_FILES", "fullWhen": ["e2e/harness/*", "scripts/e2e.sh"] }
    }
  ]
}
```

- `steps` (required, non-empty): the steps, run in this order. Each has:
  - `name` (required, unique): what the Gate prints for the step.
  - `command` (required): a command run by `bash -c` from the root of the worktree the Gate runs in, with stdin closed and stdout and stderr going to the log. A non-zero exit fails the step.
  - `unlessExists` (optional): a path relative to the worktree root. While it exists the step is skipped without a word; it is checked as the step comes up, so an earlier step may create it. For an install step that only a fresh worktree needs.
  - `quick` (optional): how `--quick` narrows the step, for a slow suite (e2e) whose files a branch adds one at a time.
    - `files` (required): a git pathspec (`*` also matches `/`) for the step's test files.
    - `env` (required): the variable the step reads them from, space-separated. The step's command does the narrowing: it reads the variable, or passes it on (`"node --test $FILES"`).
    - `fullWhen` (optional): pathspecs for files that every one of the step's tests depends on (a harness, a fake, a script). When a changed file matches one, deleted ones included, `--quick` runs the step in full.
- `env` (optional): variables set for every step. A value is a string, in which `$NAME` and `${NAME}` are replaced by the variable's value in the environment the Gate started in (empty when unset; nothing else is expanded), or `null` to unset the variable.

`verkstad gate` checks the whole Contract before it runs anything, and a missing file, invalid JSON, a missing or mistyped field or an unknown field in `gate` fails naming the field (`.claude/harness.json: gate.steps[1].command must be a non-empty string`). It also refuses to run when git would track the log directory.

**Output.** One `ok  <name>` line per step that passes, then `Gate passed. Log: <path>`. At the first failing step it stops, and prints on stderr which step failed and how (exit code or signal), that step's last 60 lines of output and the full log's path, and exits 1. The full log, `<log directory>/gate-<worktree>-<YYYYmmdd-HHMMSS>.log`, has every step's output under a `== <name>` line.

**`--quick`.** A step with `quick` gets the files matching `quick.files` that the branch added or changed since it left the base branch (`git merge-base HEAD origin/<baseBranch>`), untracked ones included, deleted ones not, and is labelled `<name> (<n> changed files)`. With none, it is skipped with a line `--  <name> skipped: …`. With a `fullWhen` match, it runs in full, labelled `<name> (in full: <file> changed)`. Every other step runs as usual, and the pass line says `Quick gate passed`. Without `--quick`, or when it runs in full, a step never sees its `quick.env` variable, even one set by the caller.

### `landing`

<!-- Documented by the Ticket that adds `verkstad land`. -->

### `surfaces`

<!-- Documented by the Ticket that adds `verkstad surfaces`. -->

### `verify`

<!-- Documented by the Ticket that adds the Verifier. -->

verkstad's own `.claude/harness.json` is an example Contract for a Project with no Surfaces.
