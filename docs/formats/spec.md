# The Spec

A GitHub issue that says what a piece of work is for and how it will behave once done, settled with the owner before any of it is built. `verkstad:spec` writes Specs in this format, and `verkstad:tickets` splits each into [Tickets](ticket.md), whose acceptance criteria it draws from the Spec's Behaviour.

A Spec is published only once it is settled: every question it raised has been answered by the owner, or recorded in an ADR, and written into it.

## Body

```md
## Problem and outcome

<3–5 lines: who has the problem, and what is different for them when it is solved.>

## Behaviour

- <What someone does, and what they then see>
- <An edge case: what someone does, and what they then see>
- <An error case: what someone does, and what they then see>

## Decisions

- <A module, interface, data shape, protocol or library chosen>: <why, in one line>

## Out of scope

- <What this Spec does not do, or what must not change>

## Test seams

<The public boundaries the tests go through, and how the Verifier will see the work on a
Surface.>
```

- **Problem and outcome** is the why that guides a Ticket writer's judgement calls: whose problem it is and what changes for them.
- **Behaviour** is concrete scenarios, each what someone does and what they then see, including the edge and error cases. The Tickets' acceptance criteria are drawn from these. Use the glossary's terms.
- **Decisions** names the modules, interfaces, data shapes, protocols and libraries chosen, each with a one-line reason. Stable module or type names are allowed; file paths and line numbers are not.
- **Out of scope** says what this Spec does not do, and what must not change.
- **Test seams** names the public boundaries the tests go through (a CLI, an HTTP route, a module's interface) and, for a change on a Surface, how the Verifier will see it there.

## Rules

- **No user stories.** Behaviour says what someone does and sees, not "As a … I want …".
- **No requirement IDs.** `verkstad:tickets` checks that the Tickets cover the Behaviour instead.
- **No glossary section.** A new term goes into [`GLOSSARY.md`](glossary.md), in the same change.
- **No open questions.** An unsettled question is settled with the owner, or recorded in an ADR, before the Spec is published.
- **No file paths or line numbers**, as in a Ticket: they go stale before the work is picked up.

## On GitHub

- A Spec is an issue whose Tickets are its **sub-issues** ([ADR 0006](../adr/0006-native-github-relations.md)); [the Ticket format](ticket.md#on-github) gives the calls that link them.
- A Spec never carries **`ready-for-agent`**: an agent implements its Tickets, never the Spec itself.
