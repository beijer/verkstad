---
name: orchestrate
description: "Run a Project's Frontier: dispatch one Tier agent per ready Ticket in its own worktree, land each with verkstad land as it finishes, Resume or Park what fails, and refill until nothing is ready or in flight."
disable-model-invocation: true
---

Drive the Project's Frontier to closed Tickets, one background agent per Ticket, in dependency order. This is a Run, and you are the orchestrator. You never write code; you dispatch, wait, land and route. Keep your own context small: a Ticket's detail lives in its agent, not in you. The token figure in the Tier agents is a guideline for quality, not a limit: past it results tend to degrade, so treat an agent that ran far over as a sign the Ticket was too large, not as a failure.

Run from the Project's main checkout. Every Ticket starts from the latest base branch and lands on it before anything that depends on it starts. The agents never push, merge, close or comment; every change to the tracker and the base branch is yours, made through the `verkstad` CLI (on the Bash tool's PATH while the plugin is enabled):

| Command | Does |
| --- | --- |
| `verkstad frontier` | Lists the Tickets that are ready, in progress and waiting, and what each waits on (`--json` for the data) |
| `verkstad gate [--quick]` | Runs the Project's Gate; the agents run it, and Landing runs it in full |
| `verkstad land <n> <worktree> <report>` | Rebases, runs the full Gate, pushes to the base branch, closes the Ticket with the report, removes the worktree and branch; a failure ends with `reason: <code>` |
| `verkstad land --park <n> <worktree> <reason>` | Parks: pushes `issue-<n>` to origin, removes the worktree, labels the Ticket `needs-info`, unassigns it and comments the reason |
| `verkstad prune` | Deletes what the log directory holds once it is 30 days old |

The log directory is `.claude/verkstad/` in the main checkout: gitignored and outside every worktree, so Landing never removes it. Reports and Park reasons go there, beside the Gate's logs.

## Steps

1. **Read the Project and check the base.** Read the Contract: `.claude/harness.json`, whose `baseBranch` is `<base>` below, and `docs/agents/project.md`, the prose doc, whose Tier examples, shared files and rules steps 3 and 5 apply. A Project without both is not set up for verkstad: stop and say so. The main checkout must be on `<base>`, clean and level with `origin/<base>` (`git fetch`, `git status`), and its `.gitignore` must cover `.claude/verkstad/` and `.claude/worktrees/`, where the agents' worktrees go; if it does not, stop and tell the user. List `git worktree list` and `git branch --list 'issue-*'`: a leftover `issue-<n>` branch means an earlier Run stopped mid-Ticket; Resume that Ticket (step 5) rather than starting it fresh. Run `verkstad prune`. Done when the base is clean and current.

2. **Read the Frontier.** Run `verkstad frontier`. A Spec (an issue with sub-issues) is never dispatched. For every Spec it lists as labelled, remove the label and say why:

   ```
   gh issue edit <n> --remove-label ready-for-agent
   gh issue comment <n> --body "Removed ready-for-agent: this is a Spec, not a Ticket. verkstad:orchestrate runs only the Tickets filed under it."
   ```

3. **Plan and confirm once.** For each ready Ticket read the body and the comments (`gh issue view <n> --comments`) and pick its Tier. Triage often happens in the comments: the latest Agent Brief or owner decision there overrides the body. It can change the scope, settle a question the body leaves open, or replace the whole plan. Pick the Tier from that, not the body. When the body and the comments disagree, go by the comments and tell the agent in its prompt which comment wins. Note each Ticket's Spec, its parent issue: `gh api 'repos/{owner}/{repo}/issues/<n>/parent'` (a 404 means it has none). Show the user one table: Ticket, Tier with a one-line reason, what can run in parallel, and which waiting Tickets hang on a human (`[human]` or `[needs-info]` in the Frontier, and anything behind them). Ask once. After the user confirms, run without asking again until step 8.

   **Tier.** Each Tier is a plugin agent; the agent fixes model, effort and turn limit, so never pass `model` to `Agent`. Pick the lowest Tier the Ticket allows.

   | Tier | Agent type | Model, effort, turns | Use when |
   | --- | --- | --- | --- |
   | light | `verkstad:ticket-light` | sonnet, medium, 100 | Copies a pattern already in the Project, few acceptance criteria, no new module, protocol or Surface. |
   | standard | `verkstad:ticket-standard` | opus, medium, 120 | Default. A new vertical slice on infrastructure earlier Tickets landed. |
   | hard | `verkstad:ticket-hard` | opus, high, 200 | Lays down what later Tickets build on (a protocol, a data model and its file format, a core pipeline), or the Ticket leaves a design decision to the agent. |

   The prose doc may give the Project's own examples for each Tier; where it does, they win over the examples here. The first Ticket of any kind (the first message of a protocol, the first import, the first file written to disk) is at least standard. When two Tiers fit, take the lower; going up a Tier on a report of `tier: too low` is cheaper than running everything hot.

   **Parallelism.** At most two agents in flight, unless the user sets another limit. Run Tickets side by side only when no two of them touch the same feature code: judge from the Ticket text which modules and UI areas each changes (both extend the same protocol, both reshape the same screen, both change the same data model: run them one after the other). Tickets that overlap form a lane and run in order; separate lanes run at once. When unsure about a pair, put them in one lane. A wrong guess costs a rebase conflict at Landing, which goes to the conflict prompt.

   The prose doc may name shared files that most Tickets add to, such as a registry of commands or a generated file. Their conflicts are small and additive, and the conflict prompt resolves them on the light Tier in a few minutes, so they do not put two Tickets in one lane. Judge overlap by the feature code, not by those files.

4. **Dispatch.** Claim the Ticket, `gh issue edit <n> --add-assignee @me`, then launch `Agent` with `subagent_type` set to the Tier's agent type, `isolation: "worktree"` and `run_in_background: true`, its prompt built from [implement-prompt.md](implement-prompt.md). Done when the agent is launched.

5. **Route each completion.** Write the agent's report to `.claude/verkstad/report-<n>.md`, then act on its `status`. Its `worktree:` line is the worktree the commands below take.
   - **done**: `verkstad land <n> <worktree> .claude/verkstad/report-<n>.md`. On success the Ticket is closed with the report and the base branch has moved; go to step 6. On failure the last line is `reason: <code>`. Except for `github-failed`, nothing landed: the Ticket is untouched and the branch `issue-<n>` kept, and except for `refused` and `error` the worktree is removed. Route on the code:
     - **`conflict`**: the message names the conflicting files. Dispatch `verkstad:ticket-light` with the conflict prompt from [conflict-prompt.md](conflict-prompt.md). When it reports done, check that the commits it names are on `issue-<n>` (`git log`), since the Gate only proves that the tests that exist pass, then land again. A conflict Resume does not count toward the one-Resume limit below; a second conflict on the same Ticket does.
     - **`gate-failed`** or **`no-commits`**: Resume the Ticket with a new agent on the same Tier, one up if the report said `tier: too low`, with the failure output from `verkstad land` (the failing step's last lines and the Gate log's path) as the reason.
     - **`push-failed`**: the base kept moving through three Gate runs, or origin refused the push. Land again once; a second `push-failed` is not the Ticket's: tell the user, with the message, and leave the branch.
     - **`refused`**: nothing was touched; the message says why. Fix a wrong call and land again. Uncommitted changes in the worktree mean the agent did not finish: show the user `git -C <worktree> status` and ask.
     - **`github-failed`**: the branch landed, but closing the Ticket failed. Close it by hand with the report as the comment, as the message says.
     - **`error`**, or a code not listed here: tell the user, with the message.
   - **partial** (ran out of turns or context): Resume one Tier up, with the report as the reason. There is no Tier above hard; Park it.
   - **blocked**: Park it. When the blocker is a decision question, put it in the final report with the agent's suggested option; when the user answers, Resume on the kept branch with the answer as the reason.

   Read the report, not only its status: a `done` whose Uncertain names a known bug or a breach of an ADR is not done. Resume it on the same Tier with that item as the reason, or treat it as blocked if it needs a decision. The report's `surfaces:` line goes on the Ticket with the rest of the report; nothing routes on it yet.

   **Resume.** Dispatch as in step 4, with the prompt's Resume paragraph. A partial or blocked agent leaves `issue-<n>` checked out in its worktree, and the new agent cannot switch to a branch checked out elsewhere: check the old worktree is clean (`git -C <worktree> status --porcelain`), then `git worktree remove -f -f <worktree>` (the finished agent's lock is stale) before dispatching. After a failed Landing the worktree is already gone.

   A Ticket that has been Resumed once and fails again is Parked. **Park**: write the blocker or failure, quoted, to `.claude/verkstad/park-<n>.md`, then run `verkstad land --park <n> <worktree> .claude/verkstad/park-<n>.md` from the main checkout, with the worktree's path even when a failed Landing already removed it. It pushes `issue-<n>` to origin, removes the worktree, swaps `ready-for-agent` for `needs-info`, unassigns you and comments the reason with where the branch is; don't repeat any of it with `gh`. A Park ending in `reason: github-failed` pushed the branch but did not update the Ticket: do that by hand, as the message says.

   Anything waiting on a Parked Ticket stays waiting. Carry on with the rest. A repeated notification from an agent you already routed carries nothing new; ignore it.

6. **Refill.** Run `verkstad frontier` again: a Landing may have unblocked Tickets. Pick Tiers for newly ready Tickets by the same rubric, without asking, and dispatch up to the parallel limit. The Frontier knows only `blocked_by` links, not overlap: a Ticket it lists as ready still waits when it would share feature code with one in flight (step 3's parallelism rule).

7. **Report while running.** After each dispatch and each completion, post one short table (Ticket, Tier, status, commit) so the user can follow. Relay only outcomes and flagged uncertainties, never agent reports in full.

8. **Finish.** Done when nothing is ready and nothing is in flight. Check CI on the base branch (`gh run list --branch <base> --limit 5`); it may run more than the Gate, such as a release build. If it is red, file a `ready-for-agent` Ticket quoting the failure, in the format of `${CLAUDE_PLUGIN_ROOT}/docs/formats/ticket.md`, and run it before finishing. Then report: the table of every Ticket this Run (Ticket, Tier, status, commit), every uncertain or undone item the agents flagged, the Parked Tickets and why, and what now waits on a human, with the Ticket numbers behind each.
