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
- **Specs and blockers** are native relations (ADR 0006): a Spec is an issue with sub-issues; a Ticket's blockers are its `blocked_by` dependencies.
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

<!-- Documented by the Ticket that adds `verkstad gate`. -->

### `gate`

<!-- Documented by the Ticket that adds `verkstad gate`. -->

### `landing`

<!-- Documented by the Ticket that adds `verkstad land`. -->

### `surfaces`

<!-- Documented by the Ticket that adds `verkstad surfaces`. -->

### `verify`

<!-- Documented by the Ticket that adds the Verifier. -->

verkstad's own `.claude/harness.json` is an example Contract for a Project with no Surfaces.
