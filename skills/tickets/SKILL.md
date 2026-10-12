---
name: tickets
description: Break a Spec into Tickets and publish them as its GitHub sub-issues, with native blocked_by links. Use when a Spec is settled and its work should become Tickets an agent can pick up.
disable-model-invocation: true
---

# Split a Spec into Tickets

Split a Spec (`#<n>`, or the conversation when there is none yet) into Tickets in verkstad's [Ticket format](../../docs/formats/ticket.md), and publish them once the owner approves the breakdown.

1. **Read.** The Spec with its comments (`gh issue view <n> --comments`), `GLOSSARY.md`, the ADRs that touch the area, and the code it changes. The Project's issue tracker is described in its `docs/agents/issue-tracker.md` and its labels in `docs/agents/triage-labels.md`.
2. **Slice.** Each Ticket is a vertical slice: a narrow path through every layer it needs, verifiable on its own, sized for one implementer session.
   - A Ticket that would lay down several layers at once (a data model, a package, a UI and their tests) becomes a thin first Ticket, end to end, that fixes the shape, and Tickets that widen it, each blocked by it.
   - A wide mechanical refactor (a rename, a retyped shared symbol) that no slice can land green becomes expand (the new form beside the old), migrate in batches, each blocked by the expand, then contract (the old form removed), blocked by every batch.
   - Prefactoring that makes the change easy comes first.
3. **Leave no decision open.** Ask the owner each design decision a Ticket raises (or record it in an ADR) and write the answer under its Decisions.
4. **Check coverage.** With a Spec, every Behaviour item of the Spec is covered by some Ticket's acceptance criteria. List any that is not, and ask the owner whether a Ticket covers it or it is dropped.
5. **Show a numbered breakdown**: each Ticket's title, what it blocks on and what it delivers end to end. Ask whether the size, the blockers and the splits are right, and revise until the owner approves.
6. **Publish** only then, blockers first, with `gh issue create`, each labelled `ready-for-agent`, a native sub-issue of the Spec when there is one, with its blockers as native `blocked_by` links, made with the calls in the Ticket format. No file paths or line numbers in any Ticket. Leave the Spec itself as it is.
7. List each Ticket as `<owner>/<repo>#<n>`, with `<owner>/<repo>` from `gh repo view --json nameWithOwner`, and its title.
