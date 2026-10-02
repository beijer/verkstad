# An independent Verifier, triggered by Surface globs

A Ticket whose change can alter a Surface lands only `live-verified`: a Verifier, a fresh agent that did not write the code, Walks its acceptance criteria and gives a Verdict. Whether a change touches a Surface is decided by the path globs each Surface declares in the Contract, matched against the diff, or by the implementer's report naming a Surface; either one is enough. We rejected a label set when the Ticket is written and the orchestrator's judgement from the Ticket's text, because both can forget a Surface and a diff cannot. We rejected verifying every Ticket, because for logic with no Surface the tests are the real proof and a Verifier run would cost a whole agent for nothing.

## Consequences

- The Verifier does not see the implementer's report, so that it does not check what the implementer checked, the same way, and stop.
- A `failed` Verdict gives the Ticket one Fix round, which does not count as its Resume. A second `failed` Parks it.
- A Project with no Surfaces never runs a Verifier, and its Tickets land at most `test-verified`.
