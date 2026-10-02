# The Ticket

A GitHub issue an agent can implement alone in one context window. `verkstad:tickets` writes Tickets from a Spec in this format; Ray's Tickets and verkstad's own are written in it.

## Body

```md
## Parent

#<Spec>

## What to build

<The behaviour this Ticket makes work, end to end, as a user or another system sees it:
a narrow path through every layer it needs, not a list of layers to change. Use the
glossary's terms.>

## Acceptance criteria

- [ ] <One observable outcome, checkable on its own>
- [ ] <…>

## Blocked by

- #<blocker>
```

- **Parent** names the Spec the Ticket belongs to; it is left out of a Ticket that has none. (Older Ray Tickets open with a `Part of #<Spec>` line instead.)
- **What to build** says what changes for whoever observes the Project. It may name types, commands, settings and messages; it explains enough of today's behaviour for the change to make sense.
- **Acceptance criteria** are a checklist. Each says what can be seen when it holds (an exit code, a line of output, what a screen shows, what a machine received), so that the implementer and the Verifier can each check it. Where the Ticket needs tests, a criterion says what they cover.
- **Blocked by** lists each blocker, or reads `None - can start immediately`.

A Ticket carries **no file paths or line numbers**: they go stale before the Ticket is picked up ([ADR 0006](../adr/0006-native-github-relations.md)). It names the behaviour, the types and the commands, which the agent finds in the code it reads then. (Some older Ray Tickets cite paths; new ones don't.)

## On GitHub

The Parent and Blocked by sections are for a reader. What the loop reads are GitHub's native relations, which `verkstad frontier` queries:

- The Ticket is a **sub-issue** of its Spec.
- Each blocker is a native **`blocked_by`** link on the Ticket.
- It is labelled **`ready-for-agent`** once an agent can take it; the Spec never is.

Publish in dependency order, blockers first, so each link has an issue to point at. The calls take an issue's database id, not its number; `{owner}/{repo}` is filled in by `gh` from the checkout:

```sh
gh api repos/{owner}/{repo}/issues/<number> --jq .id                                       # an issue's id
gh api --method POST repos/{owner}/{repo}/issues/<spec>/sub_issues -F sub_issue_id=<ticket id>
gh api --method POST repos/{owner}/{repo}/issues/<ticket>/dependencies/blocked_by -F issue_id=<blocker id>
```

`gh api repos/{owner}/{repo}/issues/<spec>/sub_issues` and `gh api repos/{owner}/{repo}/issues/<ticket>/dependencies/blocked_by` read them back.

## Later on the issue

A Ticket's body is its brief. Comments added later (an owner's decision, an [Agent Brief](agent-brief.md) written in triage) override the body where they differ, and say so.
