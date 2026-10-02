---
name: tickets
description: Break a Spec into Tickets and publish them as its GitHub sub-issues, with native blocked_by links. Use when a Spec is settled and its work should become Tickets an agent can pick up.
disable-model-invocation: true
---

This is a Borrowed skill: follow `mattpocock-skills:to-tickets`.

That skill is user-only, so the Skill tool cannot invoke it: read it instead. This prints its path:

    ls ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/*/mattpocock-skills/*/skills/*/to-tickets/SKILL.md | sort -V | tail -1

If it prints nothing, the mattpocock-skills plugin is not installed: stop and say so. Otherwise follow it as written, with verkstad's rules where they differ:

- The Project's issue tracker is described in its `docs/agents/issue-tracker.md` and its labels in `docs/agents/triage-labels.md`; where the skill says to run a setup skill for them, read those instead.
- Write and publish each Ticket as verkstad's [Ticket format](../../docs/formats/ticket.md) says: a native sub-issue of its Spec, its blockers as native `blocked_by` links, no file paths or line numbers.
