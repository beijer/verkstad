# Specs and blockers are native GitHub relations

A Spec is an issue whose Tickets are its GitHub sub-issues, and a Ticket's blockers are GitHub's native `blocked_by` dependencies. The Frontier is a query on those relations: no title prefix marks a Spec, and no script parses a `## Blocked by` section. We rejected the text conventions Ray started with, because text can be mistyped and reformatted, and GitHub shows native relations in its UI and returns them from its API.

## Consequences

- A Project that adopts verkstad with tickets blocked by text converts them once to native links.
- Tickets carry no file paths or line numbers; they go stale before the Ticket is picked up.
