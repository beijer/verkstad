---
name: triage
description: Move issues through the triage labels, and write an Agent Brief for each one made ready for an agent. Use when issues need triaging, or one needs an Agent Brief before an agent can take it.
disable-model-invocation: true
---

This is a Borrowed skill: follow `mattpocock-skills:triage`.

That skill is user-only, so the Skill tool cannot invoke it: read it instead. This prints its path:

    ls ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/*/mattpocock-skills/*/skills/*/triage/SKILL.md | sort -V | tail -1

If it prints nothing, the mattpocock-skills plugin is not installed: stop and say so. Otherwise follow it as written, reading the files it links from beside it, with verkstad's rules where they differ:

- The Project's issue tracker is described in its `docs/agents/issue-tracker.md` and its labels in `docs/agents/triage-labels.md`; where the skill says to run a setup skill for them, read those instead.
- Write each Agent Brief in verkstad's [Agent Brief format](../../docs/formats/agent-brief.md).
- Each issue you show the owner is written `<owner>/<repo>#<n>`, with `<owner>/<repo>` from `gh repo view --json nameWithOwner`.
- The owner you are talking to is the reporter. On a `needs-info` issue, its open questions are in the latest triage notes or in a Park's comment (the one ending `Parked: branch …`): ask the owner each one, a round at a time.
- An issue with an open design decision is not made `ready-for-agent`: ask the owner (or record it in an ADR) and write the answer into the Agent Brief first. One too big for one implementer session is split as the [Ticket format](../../docs/formats/ticket.md) says.
- On a `ready-for-human` issue, decide with the owner whether it stays theirs or can be written up for an agent.
- Before you post anything or change a label, show the owner the comment and the label change, and make them only once the owner says yes. A Parked Ticket keeps its branch, so once it is `ready-for-agent` again the next Run Resumes it.
