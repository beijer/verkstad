---
name: start-run
description: "Start a Run of the Project's Frontier with `verkstad run`: check the Project is set up, show the plan and confirm it once, watch the Run, and report what landed, what was Parked and what waits on the owner."
disable-model-invocation: true
---

# Start a Run

`verkstad run` is the Run: it works the Frontier one Ticket at a time and decides everything about each Ticket in code. This skill only launches it, watches it and reports on it. Never route, retry, land or Park a Ticket yourself, and never second-guess a step the Run took: when its output and the Contract (`${CLAUDE_PLUGIN_ROOT}/docs/contract.md`, its `verkstad run` section) do not explain something, tell the owner.

Run from the Project's main checkout. Write every Ticket you show the owner as `<owner>/<repo>#<n>`, with `<owner>/<repo>` from `gh repo view --json nameWithOwner`, which makes it a link.

## Steps

1. **Check the Project is set up.** It has a Contract: `.claude/harness.json` and `docs/agents/project.md`. Without both, stop and tell the owner to run `/verkstad:setup`. When the Contract's `surfaces` are not empty, its `verify` names a Verify skill and `.claude/skills/<verify>/SKILL.md` exists; when not, stop and tell the owner to run `/verkstad:create-verify`.

2. **Show the plan and confirm once.** Run `verkstad run --dry-run`. It claims nothing; it prints the ready Tickets with their Tiers and which comes next, or that nothing is ready, or why it refuses to start. On a refusal or an empty Frontier, show what it printed and stop. Otherwise show the plan and ask the owner once whether to start, and with which options (`--max <n>` Tickets at most, `--budget <usd>` for every session in place of its default). Do not ask again.

3. **Start it and watch it.** Run `verkstad run` with the owner's options as a background command (the Bash tool's `run_in_background`), and read its output as it comes. Each line names a Ticket and a step; relay a line to the owner when a Ticket lands, is Parked, or the Run stops, not every step. Do not start anything else in the main checkout while it runs: the Run owns it, its worktrees and the base branch.

4. **Report when it ends.** Its last lines are the summary: `Run finished` or `Run stopped`, its sessions and cost, one line per Ticket, and a last line saying whether the Run gave reflect something to learn from. The event log, the newest `.claude/verkstad/run-*.jsonl`, has each step, each session's ending and cost, and each Park's reason. Report:
   - what landed: each Ticket and its commit (`git log --oneline` on the base branch);
   - what was Parked and why, from the Park's reason;
   - why it stopped, when it stopped: its last line says what failed and needs the owner;
   - what waits on the owner: a Ticket that added a Surface the Contract lacks (the Run says to run `/verkstad:setup`, then `/verkstad:create-verify`), the Parked Tickets' questions, and the latest CI on the base branch (`gh run list --branch <baseBranch> --limit 5`); when it is red, quote the failure and offer to file a Ticket for it in the format of `${CLAUDE_PLUGIN_ROOT}/docs/formats/ticket.md`.

   Last, relay the summary's last line. Suggest `/verkstad:reflect`, which reads the Run and proposes changes to the loop for the owner to approve, only when that line does, with what it names; when it says the Run was clean, say so and suggest nothing.
