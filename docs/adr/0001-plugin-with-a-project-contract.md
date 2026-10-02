# A Claude Code plugin with a project contract

verkstad ships as a Claude Code plugin in its own public repo, which is also its marketplace, and holds everything that is the same in every Project: the skills, the agents, and the scripts that list the Frontier, run the Gate and land Tickets. A Project supplies only its Contract (`.claude/harness.json` for the scripts, `docs/agents/project.md` for the agents) and its Verify skill, never a copy of a verkstad script. We rejected a repo template copied into each Project, because the copies drift and a fix made while working in one Project never reaches the next.

## Consequences

- Something a Project needs to differ becomes a setting in the Contract, not a fork of a script.
- Claude Code only: the loop is built on its subagents, worktrees and plugins, and supporting other agent tools would mean designing for what they all share.
- GitHub Issues only, for now: the Frontier, Landing and Verdict comments talk to `gh`. Another tracker would be one more adapter behind the same scripts.
- One owner per Project. Nothing here handles two people claiming the same Ticket.
