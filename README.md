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

In a repo, `/verkstad:setup` makes it a Project: it writes the Contract and the agent docs, asking what it can't find out, creates the triage labels (`verkstad labels`) and runs the Gate and the Frontier once to prove them. Run it again on a Project to check it; it changes nothing it finds correct.

To start a new Project, run `/verkstad:setup` in an empty directory. Once you agree, it runs `git init`, creates the GitHub repo with `gh repo create` and pushes the first commit, with an empty Gate and no Surfaces. The first Spec's first Ticket scaffolds the Project and adds its tests as a Gate step. When a Ticket adds something a user can observe (the first UI, a CLI's first command), the Run stops dispatching and tells you to run `/verkstad:setup` again to declare the Surface, then `/verkstad:create-verify` to write the Verify skill the Verifier needs.

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

In a Project, a Run works the Frontier: in Claude Code, from the Project's main checkout, `/verkstad:start-run` shows its plan once, then starts `verkstad run`, which hands the ready Tickets to the Tier agents (`ticket-light`, `ticket-standard`, `ticket-hard`), one at a time. When a Ticket's change touches one of the Project's Surfaces, the `verifier` agent, which never sees the implementer's report, Walks its acceptance criteria with the Project's Verify skill and records a Verdict; each Ticket lands with `verkstad land` once it is done and, where its diff touches a Surface, `live-verified`.

After a Run, `/verkstad:reflect` reads it (its event log and its sessions' transcripts through `verkstad run-log`, its Gate logs and Verdicts) and proposes changes to the loop, each with its evidence; it applies only those you approve.

## Develop

Node 24, no build step: `npm ci`, then `npm run typecheck` and `npm test`. [CLAUDE.md](CLAUDE.md) has the conventions; [docs/contract.md](docs/contract.md) describes the Contract a Project gives verkstad.
