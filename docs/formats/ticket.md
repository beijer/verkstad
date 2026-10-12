# The Ticket

A GitHub issue an agent can implement alone in one context window. `verkstad:tickets` writes Tickets from a Spec in this format; Ray's Tickets and verkstad's own are written in it.

Two rules make an issue a Ticket, and an issue that breaks either is not labelled `ready-for-agent`:

- **No design decision is left to the agent.** Each one the work raises (which of two models, whether to reopen or rebuild, how a feature not built yet will behave) goes to the owner, or into an ADR, before the label, and the answer is written into the issue. An implementer that meets one mid-Ticket can only stop blocked, and the Ticket is Parked.
- **It fits one implementer session.** A Ticket that would lay down several layers at once (a new data model, a package, a UI and their tests) is split: a thin first Ticket, end to end, that fixes the shape, then Tickets that widen it, each blocked by that first one.

## Body

```md
## Parent

#<Spec>

## What to build

<The behaviour this Ticket makes work, end to end, as a user or another system sees it:
a narrow path through every layer it needs, not a list of layers to change. Use the
glossary's terms.>

## Acceptance criteria

- [ ] <One action, and what is then seen>
- [ ] <…>

## Decisions

- <An answer of the owner's this Ticket depends on, one line>

## Out of scope

- <Nearby work an agent might widen into>

## Blocked by

- #<blocker>
```

- **Parent** names the Spec the Ticket belongs to; it is left out of a Ticket that has none. (Older Ray Tickets open with a `Part of #<Spec>` line instead.)
- **What to build** says what changes for whoever observes the Project. It may name types, commands, settings and messages, and an existing module or pattern to copy; it explains enough of today's behaviour for the change to make sense.
- **Acceptance criteria** are a checklist. Each is one action and what is then seen (an exit code, a line of output, what a screen shows, what a machine received), checkable on its own by the implementer and by the Verifier: "With no Controller connected, pressing Start shows *No Controller* and Start stays locked." A criterion mentions setup (a fixture, a device state) only when it needs something the Project's Verify skill and `docs/agents/project.md` don't already give. Where the Ticket needs tests, a criterion says what they cover.
- **Decisions** (optional) lists the owner's answers the Ticket depends on, one line each, so that no design decision is left to the agent.
- **Out of scope** (optional) is there only when there is nearby work an agent might widen into, and names it.
- **Blocked by** lists each blocker, or reads `None - can start immediately`.

A Ticket carries **no file paths or line numbers**: they go stale before the Ticket is picked up ([ADR 0006](../adr/0006-native-github-relations.md)). It names the behaviour, the types, the commands and any module or pattern to copy, which the agent finds in the code it reads then. (Some older Ray Tickets cite paths; new ones don't.)

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
