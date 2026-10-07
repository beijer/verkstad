# The Contract

What a Project tells verkstad about itself, in two files at fixed paths in the Project:

- `.claude/harness.json`: for the scripts, read by the `verkstad` CLI. JSON, described below.
- `docs/agents/project.md`: for the agents, in prose: what an agent must know to work in the Project (a PATH it needs, a rule such as never touching real hardware, a generated file it must regenerate). verkstad's prompts carry nothing about any one Project; this doc does.

Neither repeats the other. A fact a script acts on goes in `harness.json`; everything else goes in `project.md`.

## The log directory

`<main checkout>/.claude/verkstad/` holds what the CLI keeps: Gate logs, Verify logs, reports, review records, Verdicts and Evidence ([docs/verdict.md](verdict.md) describes a Verdict's file and its Evidence directory). It is gitignored (a Project adds `.claude/verkstad/` to its `.gitignore`, and `.claude/worktrees/`, where a Run's agents get their worktrees) and lies outside every worktree, so removing a worktree never removes what it holds. The CLI finds the main checkout from any worktree with `git rev-parse --path-format=absolute --git-common-dir`.

An implementing agent's session is isolated to its worktree, so it cannot write to the log directory; it keeps its notes and Walk evidence under its worktree's own `.claude/verkstad/`, which the same `.gitignore` line covers. Whenever `verkstad land` (with or without `--park`, a failed Landing included) removes a worktree, it first moves what is under that directory into the log directory, merging directories, dating each moved entry now so that the prune that follows keeps it, and prints `Moved <k> entries from the worktree's .claude/verkstad/ into <log directory>:` (`1 entry` for one) and one line per entry moved. A file whose name the log directory already has is kept, and the moved one is renamed beside it (`notes-7.md` becomes `notes-7-2.md`, then `-3`, …) and listed `notes-7.md, as notes-7-2.md`. When an entry cannot be moved, it stops there, says why, and keeps the worktree, and with it the branch, rather than lose what is left in it.

`verkstad review record`, which `verkstad:review` runs once its reviews are back, records that the branch of the worktree it runs in was reviewed: `review-<branch>.json` (a `/` in the branch written `%2F`) holds `branch`, `commit` (the full SHA HEAD was on) and `recordedAt` (ISO 8601). A second review of the branch replaces it. It fails on a detached HEAD.

## What GitHub holds

Some of what the CLI needs lives on GitHub rather than in `harness.json`, and is the same in every Project:

- **The repo** is whichever one `gh repo view` resolves from the Project's checkout (its `origin`, or `GH_REPO`).
- **Specs and blockers** are native relations (ADR 0006): a Spec is an issue with sub-issues; a Ticket's blockers are its `blocked_by` dependencies. A Project that named them in issue text converts them once with `verkstad convert-links`: each open issue becomes a sub-issue of the first `#<n>` under its `## Parent` heading (or on a `Part of #<n>` line), and is blocked by every `#<n>` under its `## Blocked by` heading, except on a line saying `None`. Closed issues are left as they are; their links are history. A reference that is not an issue in the repo, or an issue that already has another parent, is reported and skipped.
- **Labels**: `ready-for-agent` puts a Ticket on the way to the Frontier. A blocker labelled `ready-for-human` or `needs-info` waits on the owner, and `verkstad frontier` marks it `[human]` or `[needs-info]`. `verkstad labels` creates the five triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`) that the repo lacks, matching names regardless of case as GitHub does; `--dry-run` only says which it would create.

`verkstad frontier` reads only these; it needs no field of `harness.json`.

## `.claude/harness.json`

A JSON object. Each field is documented here by the Ticket that first gives it a reader in the CLI; until then a field's shape may still change.

| Field | Reader | Meaning |
| --- | --- | --- |
| `baseBranch` | `gate --quick`, `land` | The branch Tickets land on. |
| `gate` | `gate`, `land` | The Gate's named steps. |
| `landing` | `land` | The Landing mode: `push` (the default) or `pull-request`. |
| `surfaces` | `surfaces`, `verdict`, `land` | The Surfaces, each a name and the path globs whose changes can alter it. `[]` for a Project with none. |
| `verify` | the agents: the Verifier, through the orchestrator, and the implementer | The name of the Project's Verify skill. |

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

- `steps` (required): the steps, run in this order; `[]` for a Project with nothing to check yet, such as a new one, whose Gate passes with a line `--  the Gate has no steps: it checked nothing`. The Ticket that adds a check (a test runner, a typecheck) adds its step. Each step has:
  - `name` (required, unique): what the Gate prints for the step.
  - `command` (required): a command run by `bash -c` from the root of the worktree the Gate runs in, with stdin closed and stdout and stderr going to the log. A non-zero exit fails the step.
  - `unlessExists` (optional): a path relative to the worktree root. While it exists the step is skipped without a word; it is checked as the step comes up, so an earlier step may create it. For an install step that only a fresh worktree needs.
  - `quick` (optional): how `--quick` narrows the step, for a slow suite (e2e) whose files a branch adds one at a time.
    - `files` (required): a git pathspec (`*` also matches `/`) for the step's test files.
    - `env` (required): the variable the step reads them from, space-separated. The step's command does the narrowing: it reads the variable, or passes it on (`"node --test $FILES"`).
    - `fullWhen` (optional): pathspecs for files that every one of the step's tests depends on (a harness, a fake, a script). When a changed file matches one, deleted ones included, `--quick` runs the step in full.
- `env` (optional): variables set for every step. A value is a string, in which `$NAME` and `${NAME}` are replaced by the variable's value in the environment the Gate started in (empty when unset; nothing else is expanded), or `null` to unset the variable.

`verkstad gate` checks `baseBranch` and `gate` before it runs anything (other fields are checked by their readers), and a missing file, invalid JSON, a missing or mistyped field or an unknown field in `gate` fails naming the field (`.claude/harness.json: gate.steps[1].command must be a non-empty string`). It also refuses to run when git would track the log directory: when neither the worktree's nor the main checkout's `.gitignore` covers `.claude/verkstad/`. (So the branch that adds it can be gated; until it lands, the logs show as untracked in the main checkout.)

**Output.** One `ok  <name>` line per step that passes, then `Gate passed. Log: <path>`. At the first failing step it stops, and prints on stderr which step failed and how (exit code or signal), that step's last 60 lines of output and the full log's path, and exits 1. The full log, `<log directory>/gate-<worktree>-<YYYYmmdd-HHMMSS>.log`, has every step's output under a `== <name>` line.

**A recorded pass.** A full Gate (not `--quick`) that passes on a worktree with no uncommitted or untracked changes, and whose steps changed no tracked file and committed nothing, also writes `<log directory>/gate-pass-<tree>.json`, naming the tree of `HEAD` (`git rev-parse HEAD^{tree}`), the commit, the log and when it passed. A step skipped by `unlessExists` does not stop the record, since its path is an install cache, not a check; `--quick`, which skips and narrows steps, is never recorded. Landing reuses it for a rebased branch with the same tree. The Contract is in the tree, so a change to the Gate's steps voids every earlier record. Records are pruned with the rest of the log directory.

**`--quick`.** A step with `quick` gets the files matching `quick.files` that the branch added or changed since it left the base branch (`git merge-base HEAD origin/<baseBranch>`), untracked ones included, deleted ones not, and is labelled `<name> (<n> changed files)`. With none, it is skipped with a line `--  <name> skipped: …`. With a `fullWhen` match, it runs in full, labelled `<name> (in full: <file> changed)` (or `<file> and <n> more`). Every other step runs as usual, and the pass line says `Quick gate passed`. Without `--quick`, or when it runs in full, a step never sees its `quick.env` variable, even one set by the caller.

### `landing`

A string, optional: the Landing mode, how `verkstad land` puts a Ticket on the base branch. `"push"`, the default, pushes the rebased branch straight to `baseBranch` and closes the Ticket. `"pull-request"`, for a Project whose base branch is protected or reviewed, pushes the rebased branch to `origin` as `issue-<n>` and opens a pull request onto `baseBranch` that closes the Ticket when the owner merges it. Any other value fails naming the field. `gate` does not read it. What Landing does is under [Landing](#landing-1) below.

### `surfaces`

An array, required: the Project's Surfaces (ADR 0004), `[]` for a Project with none. A Ticket whose branch changes a path one of them matches lands only with a `live-verified` Verdict.

```json
"surfaces": [
  { "name": "ui", "globs": ["src/**", "!src/**/*.test.ts", "index.html"] },
  { "name": "api", "globs": ["server/routes/**"] }
]
```

Each Surface has:

- `name` (required, unique): what `verkstad surfaces`, the Verdict check and the closing comment call it.
- `globs` (required, non-empty): globs, relative to the Project's root, for the paths whose changes can alter the Surface. They are git pathspecs with the `glob` magic (`:(glob)<glob>`): `*` matches within one directory, so `*.html` is `index.html` but not `docs/page.html`; `**` matches across directories, so `src/ui/**` is everything under `src/ui/`. A glob starting with `!` takes the paths it matches out of the Surface, whichever of its globs matched them: `!src/**/*.test.ts` keeps the tests beside the code out, since a change to a test alone cannot alter what a user sees. It applies to its own Surface only, and a Surface needs at least one glob without `!`. A glob, after its `!`, may not be empty or start with `:` or `/`.

A missing or malformed field fails naming it (`.claude/harness.json: surfaces[0].globs must be a non-empty array of globs`). `gate` does not read `surfaces`; `land` refuses a Contract whose `surfaces` are malformed.

**`verkstad surfaces <base> [--json]`** prints, one per line in the Contract's order, each Surface touched by the branch checked out where it runs: a Surface is touched when one of its globs, and none of its `!` globs, matches a path the branch's commits changed since it left `<base>` (`git diff <base>...HEAD`, so not what landed on `<base>` meanwhile). A deleted path counts, and a renamed one counts as both its old and its new path, so moving a file out of a Surface touches it. Uncommitted and untracked files are not part of the branch, and do not count: the branch is what lands and what a Verdict is given for. It prints nothing when the branch touches no Surface. With `--json` it prints an array of `{ "name": "ui", "files": ["src/ui/panel.ts"] }`, the changed paths each Surface's globs matched, `[]` for none. The orchestrator unions these with the Surfaces the implementer's report names.

### `verify`

A string, required when `surfaces` is not empty: the name of the Project's Verify skill (`verify-<app>`, in `.claude/skills/`), which teaches an agent to launch the Project, check it with its Doctor, drive its Surfaces and capture Evidence. `verkstad:create-verify` writes one. No script reads it: `verkstad:orchestrate` passes it to the Verifier, which Walks a Ticket's acceptance criteria with it, and an implementer Walks its own change with it before writing the change's end-to-end test.

```json
"verify": "verify-ray"
```

verkstad's own `.claude/harness.json` is an example Contract for a Project with no Surfaces.

## Landing

`verkstad land <n> <worktree> <report-file>` lands Ticket `#<n>`, whose branch `issue-<n>` is checked out in `<worktree>`, with the implementer's report in `<report-file>`. It refuses, touching nothing, when the worktree is the main checkout, is on another branch, has uncommitted changes (untracked files included), or the report file is missing or empty, or the worktree's Contract is malformed. It fails with `review-missing`, changing nothing, when no review of `issue-<n>` is recorded in the log directory, or its `review-issue-<n>.json` is malformed (above): any recorded review of the branch counts, whatever commit it was on, since the implementer commits its fixes after the review and a rebase rewrites every commit. Otherwise:

1. It takes the main checkout's Landing lock (`<git common dir>/verkstad-land.lock`, held with flock(1)), so one Landing runs at a time per main checkout; a second says it is waiting and runs when the first is done. The kernel releases the lock when a Landing exits, however it exits, so a lock is never stale.
2. It fetches `origin/<baseBranch>`, rebases the branch onto it and checks the Verdict, as `verkstad verdict check` does ([docs/verdict.md](verdict.md)): a branch that touches a Surface needs a `live-verified` Verdict for its rebased patch. It checks before the Gate, so that a branch its Verdict refuses costs no Gate run.
3. It runs the full Gate in the worktree (never `--quick`), printing the Gate's lines. When a full pass on the rebased tree is recorded (**A recorded pass**, above), it runs no step and prints `Reused the full Gate pass recorded for tree <tree>; no step ran.` instead; a pass on the same tree is trusted whatever the environment it ran in.
4. It pushes `HEAD` to `<baseBranch>` on `origin`. When the push is rejected because the base moved meanwhile, it says so and goes back to 2; after 3 attempts it gives up.
5. It closes the Ticket with the comment `Landed on <baseBranch> in <sha>.`, a blank line, the report, a blank line and how far the Ticket was proven (below); removes the worktree, the branch, its review record (so that a later `issue-<n>` needs a review of its own), and the branch on `origin` if an earlier Park pushed it; fast-forwards the main checkout when it is on a clean `<baseBranch>` (and says so when it is not); and prunes the log directory.

When the Landing reused a recorded Gate pass, the line `The Gate was not run again: a full pass on this tree (<tree>) was recorded before.` comes before it. The closing comment ends with the Ticket's Verification state and the Surfaces it touched. With a Verdict for the landed patch, that is the Verdict's state, its Evidence directory and a line per acceptance criterion:

```
Verification state: live-verified. Surfaces: ui. Evidence: `/home/me/code/app/.claude/verkstad/evidence-7`.

- The panel shows the job's time: Opened the panel: it read 3 min 12 s.
```

Without one, which only a Ticket touching no Surface lands with, it is `Verification state: test-verified. Surfaces: none.`: its tests, run by the Gate, are what proved it. Only a `live-verified` Verdict makes a Ticket more than `test-verified`: a Ticket touching no Surface lands whatever its Verdict says, and closes `test-verified`, with `The Verifier's Verdict for this patch was <state>.`, its Evidence and its criteria after the Surfaces.

It prints `Landed #<n> on <baseBranch> in <sha> and closed it.` and exits 0.

That is the `push` Landing mode. In the `pull-request` mode steps 1 to 3 are the same, and then:

4. It force-pushes `HEAD` to `issue-<n>` on `origin`, over whatever an earlier Park or Landing put there. It does not touch `<baseBranch>`, so a base that moves meanwhile does not matter and it never rebases again.
5. It opens a pull request from `issue-<n>` onto `<baseBranch>`, titled as the Ticket, whose body is `Closes #<n>.`, a blank line, the report, a blank line and how far the Ticket was proven, as in the closing comment. When a pull request from `issue-<n>` onto `<baseBranch>` is already open, from an earlier Landing of the Ticket, it replaces that one's body instead; the push has already updated its commits.
6. It removes the worktree, the local branch and its review record (the pull request's branch is on `origin`, and a leftover local `issue-<n>` would tell the next Run that the Ticket stopped mid-way) and prunes the log directory. It leaves the main checkout alone, since the base has not moved.

The Ticket stays open, and assigned, until the owner merges the pull request, which closes it; `verkstad frontier` lists it as in progress meanwhile, so no Run dispatches it again, and the Tickets it blocks wait for the merge. It prints `Opened <url> onto <baseBranch> for #<n> (issue-<n> at <sha>); #<n> closes when it merges.`, or `Updated <url> …` for a pull request that was open, and exits 0.

Every failure, in either mode, prints what failed on stderr, `verkstad land: …`, and ends with a line `reason: <code>` the orchestrator routes on. A refusal exits 2, any other failure 1. A Landing that fails before its push touches no issue and no pull request, and keeps the branch. It also removes the worktree, so that a Resume can switch to the branch, except after `refused`, `error`, `review-missing`, which changed nothing, a failed Verdict check, whose worktree the Verifier Walks next, and `gate-flaky`, whose worktree the next Landing uses.

| Reason | What failed | The branch |
| --- | --- | --- |
| `refused` | The call: arguments, worktree, report or Contract, as above. | Untouched, worktree too. |
| `review-missing` | No review of the branch is recorded, or its record is malformed: the implementer did not run `verkstad:review`. A Resume reviews it. | Untouched, worktree too. |
| `no-commits` | After the rebase the branch has nothing that is not on `origin/<baseBranch>`. | Kept. |
| `conflict` | The rebase conflicted; the message names the conflicting files. | Kept as it was before the rebase. |
| `gate-failed` | The full Gate; the message has the failing step's last lines and the Gate log's path. | Kept, rebased. |
| `gate-flaky` | The full Gate failed, but the branch as it stood before the rebase had a full pass recorded: the failure is a flake in the Project's tests, or an interaction with what the base gained, not the Ticket's work. The message names the log of that pass and the failing run's log. Landing again settles it when it was a flake; a second failure, which ends `gate-failed` since the rebased tree has no pass, is the owner's. | Kept, rebased, in its worktree. |
| `verdict-missing` | The branch touches a Surface, and the Ticket has no Verdict, or its Verdict file is malformed. The Verifier Walks it. | Kept, rebased, in its worktree. |
| `verdict-void` | The branch touches a Surface, and its Verdict was given for another patch: a conflict resolution or a new commit changed it. Whatever the Verdict's state, the Verifier Walks it again. | Kept, rebased, in its worktree. |
| `verdict-not-live` | The branch touches a Surface, and its Verdict for this patch is `test-verified`, `blocked` or `failed`; the message names it. The orchestrator routes on the state (a Fix round, or Park). | Kept, rebased, in its worktree. |
| `push-failed` | `origin` refused the push, or the base moved during each of the 3 Gate runs (`push` mode). | Kept, rebased. |
| `github-failed` | The branch landed (or, with `--park` or in `pull-request` mode, was pushed) and the worktree is removed, but updating the Ticket, or opening or updating its pull request, failed: finish it by hand. | Landed and deleted (in `pull-request` mode, on `origin` and deleted locally; with `--park`, kept). |
| `error` | Anything else: git, gh or flock could not run, or the fetch failed. | Wherever the Landing stopped; the worktree is not removed. |

The orchestrator routes an unknown reason to the owner.

`verkstad land --park <n> <worktree> <reason-file>` Parks Ticket `#<n>`, with the same refusals, except that a worktree a failed Landing already removed is fine as long as the branch `issue-<n>` is in the Project `land` runs in. It force-pushes `issue-<n>` to `origin`, removes the worktree if there is one and keeps the branch, then labels the Ticket `needs-info` instead of `ready-for-agent`, unassigns `@me`, and comments with the reason file's text and where the branch is. It takes no lock and runs no Gate.

`verkstad prune` deletes each entry of the log directory older than 30 days, a directory being as old as the newest file in it, and lists what it deleted. Landing runs it after each Landing.
