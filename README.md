# verkstad

A Claude Code plugin for a solo developer's agent loop: from a Spec, through Tickets implemented by agents in their own worktrees, to a change that lands on main only once it is proven, with an independent Verifier walking anything a user can observe.

Work in progress. Ray (`beijer/ray`) is the first Project to use it.

- [CONTEXT.md](CONTEXT.md): the words verkstad uses and what each means.
- [docs/adr/](docs/adr/): the decisions that shape it, and why.
- [docs/formats/](docs/formats/): the formats a Project's glossary, ADRs, agent docs, Tickets and Agent Briefs are written in.

## Install

The repo is its own Claude Code plugin marketplace. Add it, from GitHub or from a local checkout, then install the plugin:

```sh
claude plugin marketplace add beijer/verkstad      # or: claude plugin marketplace add ~/code/verkstad
claude plugin install verkstad@verkstad
```

Inside Claude Code the plugin puts `verkstad` on the PATH. Elsewhere, run `bin/verkstad` from the checkout:

```sh
verkstad frontier          # the Tickets ready now, in progress and waiting
verkstad frontier --json   # the same, as data
```

A Project whose issues name their Spec and blockers in text (`## Parent`, `## Blocked by`) converts them once to native links, which is what `verkstad frontier` reads:

```sh
verkstad convert-links --dry-run   # what it would link, and what it skips and why
verkstad convert-links             # add the links; a second run adds nothing
```

In a Project, a Run works the Frontier: in Claude Code, from the Project's main checkout, `/verkstad:orchestrate` shows its plan once, then dispatches the ready Tickets to the Tier agents (`ticket-light`, `ticket-standard`, `ticket-hard`), two at a time, and lands each with `verkstad land` as it finishes.

## Develop

Node 24, no build step: `npm ci`, then `npm run typecheck` and `npm test`. [CLAUDE.md](CLAUDE.md) has the conventions; [docs/contract.md](docs/contract.md) describes the Contract a Project gives verkstad.
