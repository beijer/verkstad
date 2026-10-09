# A Run may work Tickets side by side

This replaces ADR 0007's consequence "A Run is serial". That consequence named two conditions for working Tickets side by side, and both now hold, on the evidence in Spec #51 from cnc-control's UI redesign. First, the sessions take the time, not the Gate: two Runs on 2026-10-09 landed 12 Tickets in about 11 hours, each implementer taking 26–47 minutes and each Verifier 3–10, with 5 of 13 needing a Fix round of about 25 minutes, while a Landing took about 5 seconds, since it reuses the implementer's last Gate pass. Second, the Frontier has Tickets that touch different code: the Tickets left there are separate pages, and the one shared doc every Ticket edited is now merged as a union (beijer/cnc-control#143).

So `verkstad run --parallel <n>` works up to `n` Tickets at once, each in its own worktree with its own sessions, and tells each implementer the number and title of the others in flight. It picks the lowest-numbered ready Tickets, as a serial Run does, with no guess at which files a Ticket will touch: Tickets carry no file paths (ADR 0006), and a guess read from their prose would be the issue-text parsing that ADR rejects. We rejected scheduling around predicted overlap for that reason, and leave overlap to Landing: Landings stay one at a time, in the Run and under Landing's lock, a later one rebasing onto the earlier; a clean rebase keeps its Verdict (ADR 0005), and a conflict goes to the Ticket's one finished conflict, as it did when the owner landed something during a serial Run.

## Consequences

- What ADR 0007 feared comes back in proportion to the overlap: conflicts, Verdicts voided by a rebase that changed the patch, and conflict sessions. A Project whose Tickets crowd one file, or whose Gate or Verify instances cannot run side by side, works one at a time.
- `--stop` finishes every Ticket in flight, and a failure that stops the Run lets the others finish first, so that nothing in flight is left half-done by another Ticket's trouble.
- The event log interleaves the Tickets' lines; each line names its Ticket, so `verkstad run-log` and the summary stay per Ticket.
