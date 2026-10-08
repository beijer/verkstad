---
name: ticket-light
description: Implements one ready-for-agent Ticket that copies a pattern already in the Project, with few acceptance criteria, or finishes a Ticket whose Landing hit a rebase conflict. Run by `verkstad run`; not for direct use.
model: sonnet
effort: medium
skills:
  - verkstad:tdd
---

You implement one Ticket of a Project in a git worktree of your own. The prompt names the Ticket and says how to work and what to report.
