# verkstad

A Claude Code plugin that runs a solo developer's agent loop from Spec to verified landing: agents implement Tickets, an independent Verifier proves what users can observe, and the loop learns from each Run.

## Projects and their contract

**Project**:
A repository that uses verkstad. Ray (`beijer/ray`) is the first.
_Avoid_: repo, app, client

**Contract**:
What a Project tells verkstad about itself: `.claude/harness.json` for the scripts (Gate commands, Landing mode, base branch, Surfaces) and `docs/agents/project.md` for the agents.
_Avoid_: config, settings, adapter

**Surface**:
Anything outside the code that a user or another system observes: a UI, a generated file, a CLI's output, an HTTP API, a connected device. A Project declares each Surface with the path globs whose changes can alter it.
_Avoid_: machine, frontend, output

**Verify skill**:
A Project's own skill (`verify-<app>`) that teaches an agent to launch the Project, check its health with the Doctor, drive it through its Surfaces one command at a time and capture Evidence.
_Avoid_: control skill, test harness

**Doctor**:
The Verify skill's read-only check that the running instance is worth driving: up, built from the current code, its dependencies answering.
_Avoid_: health check, smoke test

**Feature map**:
The Verify skill's index of user-facing features, one file each: its sub-features, how a user reaches it, how to drive it (a pointer to the e2e test when one exists) and its gotchas.
_Avoid_: test plan, feature list

## Work

**Spec**:
An issue describing a whole piece of work, with its Tickets as GitHub sub-issues. Never implemented directly.
_Avoid_: PRD, epic, parent ticket

**Ticket**:
An issue an agent can implement alone in one context window: what to build, acceptance criteria, and its blockers as native `blocked_by` links.
_Avoid_: task, story, slice

**Frontier**:
The Tickets ready to start now: open, labelled `ready-for-agent`, unassigned, with no open blocker.
_Avoid_: queue, backlog

**Tier**:
Which implementing agent a Ticket gets (`ticket-light`, `ticket-standard`, `ticket-hard`), each a fixed model, effort and turn limit.
_Avoid_: level, size

**Borrowed skill**:
A verkstad skill that, for now, only says to follow another plugin's skill (e.g. `verkstad:tdd` → `mattpocock-skills:tdd`), until verkstad writes its own.
_Avoid_: wrapper, alias, dependency

## Proof

**Walk**:
Driving the changed flow on its Surface with the Verify skill until each acceptance criterion has been seen working or a bug has been found.
_Avoid_: smoke test, manual test, click-through

**Verifier**:
The agent that Walks a Ticket's acceptance criteria after the implementer is done, seeing the Ticket, the diff and the Verify skill but never the implementer's report. It never edits source.
_Avoid_: reviewer, QA agent

**Verdict**:
The Verifier's result for one Ticket: a Verification state, the patch-id it was given for, and one line per acceptance criterion saying what was seen.
_Avoid_: review, approval, sign-off

**Verification state**:
How far a landed Ticket was proven: `live-verified` (seen on its Surface by the Verifier), `test-verified` (its tests only), `blocked` (needs a human, e.g. real hardware) or `failed`.
_Avoid_: status, confidence

**Evidence**:
What a Walk captured to back a Verdict: screenshots, output, generated files. Kept outside the worktree so that Landing doesn't remove it.
_Avoid_: artifacts, proof, logs

## The loop

**Run**:
One `verkstad:orchestrate` session, or one `verkstad run`, that works the Frontier until nothing is ready or in flight.
_Avoid_: batch, session, sprint

**Gate**:
The Project's checks a change must pass before it lands: CI without the release build. It prints only failures and keeps its full log.
_Avoid_: CI, checks, test suite

**Landing**:
Putting a finished Ticket's branch on the base branch: rebase, Verdict check, Gate (or a full pass already recorded for the rebased tree), then, depending on the Project's Landing mode, a push that closes the Ticket with its report and Verdict, or a pull request that carries them and closes the Ticket when the owner merges it.
_Avoid_: merge, ship, deploy

**Fix round**:
A Ticket sent back to its implementer once because its Verdict was `failed`, with the Verifier's findings as the reason. It is not a Resume.
_Avoid_: retry, rework

**Resume**:
A Ticket restarted by a new agent on its kept branch after a red Gate, a partial report or a blocker the owner has since answered. A Ticket gets one.
_Avoid_: retry, restart

**Park**:
Stopping work on a Ticket for the owner: its branch is pushed, its label becomes `needs-info`, and anything blocked by it waits.
_Avoid_: abandon, shelve

**Reflect**:
Reading a finished Run's transcripts, logs and Verdicts to propose changes to skills, scripts or the Contract. A lesson seen twice becomes a script or a check rather than prose. The owner approves every change.
_Avoid_: retro, post-mortem
