# The agent docs: `docs/agents/`

What an agent needs to know about a Project's tooling, one file per topic in `docs/agents/`, each pointed at from a short section of the Project's `CLAUDE.md`. Ray's agent docs are written in this format.

| File | What it says |
| --- | --- |
| `issue-tracker.md` | Where issues live and the `gh` commands for them. |
| `triage-labels.md` | The label string for each triage role. |
| `domain.md` | Where the glossary and ADRs are, and how agents use them. |
| `project.md` | The prose half of the Contract; see [the Contract](../contract.md). |

A Project adds files of its own beside these for anything else agents must know (Ray: `e2e-tests.md`, `wire-types.md`).

## The pointer in `CLAUDE.md`

`CLAUDE.md` has an `## Agent skills` section with one `###` heading per agent doc: a sentence or two saying what it covers, then `See docs/agents/<file>.md.` Ray's:

```md
## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for `beijer/ray` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
```

## `issue-tracker.md`

Ray's, which is the format:

````md
# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.
````

The `/triage` it names is `verkstad:triage` in a verkstad Project. Ray's copy also has a section on wayfinding operations, for a tool the loop does not use; a Project may keep sections like it, and verkstad reads only those above.

**verkstad's addition** ([ADR 0006](../adr/0006-native-github-relations.md)): a section on Specs and blockers, which Ray's copy does not have yet.

```md
## Specs and blockers

A Spec's Tickets are its native sub-issues, and a Ticket's blockers are its native `blocked_by` links; nothing reads a blocker from an issue's text. `verkstad:tickets` publishes them, with the `gh api` calls in verkstad's Ticket format.
```

## `triage-labels.md`

Ray's, which is the format:

```md
# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.
```

The first column names the canonical roles, after the skill collection they came from; only the middle column is the Project's to change. The loop reads three of them: `ready-for-agent` puts a Ticket on the way to the Frontier, `needs-info` marks a Parked Ticket, and a blocker labelled `needs-info` or `ready-for-human` waits on the owner.

## `domain.md`

Ray's shape, with the skills it names left generic:

````md
# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists — it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. They are created lazily, when terms or decisions actually get resolved.

## File structure

Single-context repo (most repos):

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

Multi-context repo (presence of `CONTEXT-MAP.md` at the root):

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← system-wide decisions
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← context-specific decisions
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
````

Where Ray's copy says which skills create the glossary and ADRs, and which skill a gap is noted for, the format says only that they are created when a term or decision is resolved. The glossary's format is [glossary.md](glossary.md) and the ADR's is [adr.md](adr.md).
