# verkstad

A Claude Code plugin: skills, agents and one `verkstad` CLI that run a solo developer's agent loop. Read CONTEXT.md first and use its words in code, tests, docs and messages; the decisions behind them are in docs/adr/.

verkstad is also its own Project: its Contract is `.claude/harness.json` plus `docs/agents/project.md`.

## Layout

- `.claude-plugin/plugin.json` and `marketplace.json`: the repo is its own marketplace, with one plugin, `verkstad`, whose source is `./`.
- `bin/verkstad`: a sh wrapper that resolves its own real path and runs `node --no-warnings <plugin root>/src/cli.ts`. Claude Code puts a plugin's `bin/` on the Bash tool's PATH, so agents run plain `verkstad`. Outside Claude Code a Project finds it on PATH or at `${VERKSTAD_HOME:-$HOME/code/verkstad}/bin/verkstad`.
- `src/cli.ts` dispatches to one module per subcommand (`src/frontier.ts`, …). `src/gh.ts` is the only way to GitHub, `src/claude.ts` the only way to Claude Code (a headless `claude -p` session), `src/git.ts` the way to git, and `src/contract.ts` reads and checks the Contract.
- `test/*.test.ts`: run by `node --test`. `test/project.ts` builds a throwaway Project; `test/stub/` holds the stub `gh` and the stub `claude`.
- `skills/<name>/SKILL.md`, `agents/<name>.md`, and `prompts/*-prompt.md`: the implementing, verifying and conflict prompts `verkstad run` fills in (`src/prompts.ts`).
- `hooks/hooks.json`: the plugin's one hook, PreToolUse, the `verkstad hook pre-tool-use` subcommand (`src/hook.ts`) run as `"${CLAUDE_PLUGIN_ROOT}"/bin/verkstad`, so that tests reach it through the CLI.
- `docs/`: the Contract (`docs/contract.md`), the Verdict file (`docs/verdict.md`) and, in `docs/formats/`, the formats a Project's files and issues are written in.
- `scripts/`: verkstad's own Gate checks that are not tests, such as `check-borrowed.sh`.

## The CLI

- TypeScript run by Node's type stripping: no build step, and no runtime dependencies beyond node, git, gh and flock(1) (util-linux, for the Landing lock; Linux only). devDependencies are only typescript and @types/node.
- Erasable syntax only: no enums, namespaces or parameter properties. Relative imports end in `.ts`. `npm run typecheck` enforces both.
- Ask gh for JSON (`--json`, `gh api`) and parse it in TypeScript, never with `--jq`; the stub refuses `--jq`. Read GitHub through native relations (sub-issues, `blocked_by`), never by parsing issue text (ADR 0006); the one exception is `convert-links`, whose job is to turn that text into relations once.
- Output is short and human-readable by default; `--json` where a Ticket asks for it. A failure throws `Failure` (src/fail.ts): the CLI prints `verkstad <subcommand>: <what failed>` and exits non-zero, 2 for usage errors. `land`'s failures print a reason code.
- Logs, Verdicts and Evidence go in the log directory, `<main checkout>/.claude/verkstad/`: gitignored and outside every worktree. Find the main checkout from `git rev-parse --path-format=absolute --git-common-dir`.

## Skills and agents

- A skill, agent or prompt calls another skill by its verkstad name (`verkstad:tdd`), never another plugin's. Only a Borrowed skill names the skill it borrows (ADR 0002). The Gate's `borrowed` step (`scripts/check-borrowed.sh`) enforces it: it fails on the borrowed plugin's name in `skills/`, `agents/`, `prompts/`, `docs/` outside `docs/adr/`, `CLAUDE.md` and `.claude/`, and on a bare slash name of one of its skills (`/to-tickets`) in `skills/`, `agents/` and `prompts/`.
- A Borrowed skill is one short `skills/<name>/SKILL.md` naming one borrowed skill; `check-borrowed.sh` sets how many lines it may have. It holds a description saying when to use it under its verkstad name, the line ``This is a Borrowed skill: follow `<plugin>:<skill>`.``, how to reach that skill, and any verkstad rule that overrides it. When the borrowed skill is user-only, so is the Borrowed one (`disable-model-invocation: true`), and it says to read the skill's SKILL.md instead of invoking it.
- A skill that writes a Project's files or issues follows the formats in `docs/formats/` (ADR 0003).
- Skills, agents and prompts are generic: nothing in them names a Project. What one Project needs an agent to know goes in that Project's prose doc, `docs/agents/project.md`, which the prompts tell the agent to read. A skill's supporting files sit beside its SKILL.md (`skills/create-verify/references/`); the prompts a Run fills in sit in `prompts/`.

## Tests

One seam: a test runs `bin/verkstad` as a process and observes exit code, stdout, stderr, the bare origin's git state, the stub's state and the `gh` and `claude` calls it recorded. Tests never import from `src/`.

- `project(t, seed)` (test/project.ts) builds a throwaway Project in a temp dir: a git repo with a Contract whose `origin` is a local bare repo, the stub `gh` and the stub `claude` first on the PATH, and a clean environment, so nothing reaches GitHub, Claude or the owner's git config.
- The stub `claude` (test/stub/claude.ts) plays the headless sessions a test scripts, in order: commands run in the session's working directory, as an agent would, then the report it prints, checked against the call's `--json-schema`. It accepts only the flags verkstad passes.
- The stub (test/stub/gh.ts) is a small fake GitHub kept in a JSON state file (types in test/stub/state.ts). It implements exactly the gh subcommands, GraphQL operations and REST endpoints verkstad calls and fails on anything else. A new call in the CLI gets a handler there, in the same commit. A GraphQL handler returns every field it can and the stub keeps only those the query selects, failing on an unknown one, so a misspelt field fails in tests. Seed `failures` to make a call fail.
- Write each test as a concrete scenario with literal expected output. A test that would still pass if the CLI did nothing is wrong. Work test-first where there is logic.

## Commits

One sentence saying what is now true, ending `Refs #<issue>`.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for `beijer/verkstad` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### The Contract

verkstad reads `.claude/harness.json` (the Gate, the Landing mode, the Surfaces); agents read `docs/agents/project.md`. See `docs/agents/project.md`.
