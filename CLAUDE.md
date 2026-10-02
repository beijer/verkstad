# verkstad

A Claude Code plugin: skills, agents and one `verkstad` CLI that run a solo developer's agent loop. Read CONTEXT.md first and use its words in code, tests, docs and messages; the decisions behind them are in docs/adr/.

verkstad is also its own Project: its Contract is `.claude/harness.json` plus `docs/agents/project.md`.

## Layout

- `.claude-plugin/plugin.json` and `marketplace.json`: the repo is its own marketplace, with one plugin, `verkstad`, whose source is `./`.
- `bin/verkstad`: a sh wrapper that resolves its own real path and runs `node --no-warnings <plugin root>/src/cli.ts`. Claude Code puts a plugin's `bin/` on the Bash tool's PATH, so agents run plain `verkstad`. Outside Claude Code a Project finds it on PATH or at `${VERKSTAD_HOME:-$HOME/code/verkstad}/bin/verkstad`.
- `src/cli.ts` dispatches to one module per subcommand (`src/frontier.ts`, …). `src/gh.ts` is the only way to GitHub.
- `test/*.test.ts`: run by `node --test`. `test/project.ts` builds a throwaway Project; `test/stub/` is the stub `gh`.
- `skills/<name>/SKILL.md`, `agents/<name>.md`.
- `docs/`: the formats and the Contract (`docs/contract.md`).

## The CLI

- TypeScript run by Node's type stripping: no build step, and no runtime dependencies beyond node, git and gh. devDependencies are only typescript and @types/node.
- Erasable syntax only: no enums, namespaces or parameter properties. Relative imports end in `.ts`. `npm run typecheck` enforces both.
- Ask gh for JSON (`--json`, `gh api`) and parse it in TypeScript, never with `--jq`; the stub refuses `--jq`. Read GitHub through native relations (sub-issues, `blocked_by`), never by parsing issue text (ADR 0006).
- Output is short and human-readable by default; `--json` where a Ticket asks for it. A failure throws `Failure` (src/fail.ts): the CLI prints `verkstad <subcommand>: <what failed>` and exits non-zero, 2 for usage errors. `land`'s failures print a reason code.
- Logs, Verdicts and Evidence go in the log directory, `<main checkout>/.claude/verkstad/`: gitignored and outside every worktree. Find the main checkout from `git rev-parse --path-format=absolute --git-common-dir`.

## Tests

One seam: a test runs `bin/verkstad` as a process and observes exit code, stdout, stderr, the bare origin's git state, the stub's state and the `gh` calls it recorded. Tests never import from `src/`.

- `project(t, seed)` (test/project.ts) builds a throwaway Project in a temp dir: a git repo with a Contract whose `origin` is a local bare repo, the stub `gh` first on the PATH, and a clean environment, so nothing reaches GitHub or the owner's git config.
- The stub (test/stub/gh.ts) is a small fake GitHub kept in a JSON state file (types in test/stub/state.ts). It implements exactly the gh subcommands, GraphQL operations and REST endpoints verkstad calls and fails on anything else. A new call in the CLI gets a handler there, in the same commit; seed `failures` to make a call fail.
- Write each test as a concrete scenario with literal expected output. A test that would still pass if the CLI did nothing is wrong. Work test-first where there is logic.

## Commits

One sentence saying what is now true, ending `Refs #<issue>`.
