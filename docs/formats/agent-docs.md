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

```md
# Issue tracker: GitHub

Issues for this repo, Specs and Tickets among them, live as GitHub issues. Use the `gh` CLI for all of them; run inside the checkout, it finds the repo from `origin`.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`, with a heredoc for a body of several lines.
- **Read an issue**: `gh issue view <number> --comments`.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments`, with `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

## Specs and blockers

A Spec's Tickets are its native sub-issues, and a Ticket's blockers are native `blocked_by` links. `verkstad:tickets` publishes them; nothing reads a blocker from an issue's text.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `verkstad:triage` reads this flag.)_

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.
```

With the flag set to `yes`, the PR section also gives the `gh pr` equivalents (`gh pr view <number> --comments`, `gh pr diff <number>`, `gh pr comment`, `gh pr edit`, `gh pr close`) and how to list external PRs: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`, keeping only `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR` and `NONE`. A Project's copy may hold further sections for other tools (Ray's has one on wayfinding operations, which also gives the `gh api` calls for native relations); verkstad reads only those above.

## `triage-labels.md`

The five triage roles, and the label string each has in this Project's tracker:

```md
# Triage Labels

The skills speak of five triage roles. This table gives the label each one has in this repo's tracker.

| Role              | Label in our tracker | Meaning                                  |
| ----------------- | -------------------- | ---------------------------------------- |
| `needs-triage`    | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`      | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human` | `ready-for-human`    | Requires human implementation            |
| `wontfix`         | `wontfix`            | Will not be actioned                     |

When a skill names a role (e.g. "apply the AFK-ready triage label"), use the label from this table.
```

Only the middle column is the Project's to change. Ray's copy heads the first column with where the roles came from; it is the role either way. The loop reads three of them: `ready-for-agent` puts a Ticket on the way to the Frontier, `needs-info` marks a Parked Ticket, and a blocker labelled `needs-info` or `ready-for-human` waits on the owner.

## `domain.md`

```md
# Domain Docs

How agents use this repo's domain documentation when they explore the code.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists: it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`**: the ADRs that touch the area you are about to work in. In a repo with several contexts, also `src/<context>/docs/adr/` for that context's decisions.

If one of these files does not exist, proceed without it and don't suggest creating it. They are created when a term or a decision is first settled.

## File structure

<A tree of where CONTEXT.md and docs/adr/ sit: at the root for one context; with CONTEXT-MAP.md for several.>

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as `CONTEXT.md` defines it, never a word it lists under `_Avoid_`. A concept the glossary lacks is either language the Project doesn't use (reconsider) or a real gap (note it).

## Flag ADR conflicts

If your output contradicts an ADR, say so rather than silently overriding it:

> _Contradicts ADR-0007 (laser-agnostic core), but worth reopening because…_
```

The glossary's format is [glossary.md](glossary.md) and the ADR's is [adr.md](adr.md).
