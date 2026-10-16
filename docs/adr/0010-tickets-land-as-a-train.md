# Finished Tickets land together as a Train behind one Gate

This replaces ADR 0008's rule that Landings are one Ticket at a time; Landings stay serial under Landing's lock, but one Landing may now carry several Tickets. Landing a Ticket after another has landed rebases it onto a new tree, so the Gate pass its implementer recorded no longer counts and a full Gate runs again; on cnc-control four small Tickets (beijer/cnc-control#392–#395) meant four full Gates in a row, each tens of minutes on a 4-core container, re-proving what one Gate on the combined tree proves. So Landing takes a Train: the finished Tickets stacked on the base branch in order, each Verdict checked against its own patch-id as ADR 0005 has it, one full Gate, one push that closes each Ticket with its own report and Verdict. A red Train is split in halves, each Gated in turn, until each red Ticket stands alone and fails as a single Landing does, while the rest land; a Ticket that conflicts in the stack, or whose Verdict the stack voids, leaves the Train with that reason. We rejected landing the stack all or nothing, because one bad Ticket would hold back every good one; trusting the implementers' separate Gate passes, because Tickets proven apart were never proven together; and ordering the stack by predicted overlap, for ADR 0008's reason that it would mean guessing from a Ticket's prose.

## Consequences

- A red Train costs about log₂(n) extra Gates to find its culprits, more than a single Landing's one; Trains pay off when most Landings are green.
- A Run lands the Tickets that finished while a Landing was going as the next Train, so Tickets that finish together share a Gate.
- A Train is designed for the push Landing mode only; `land --train` refuses in a Project that lands through pull requests.
