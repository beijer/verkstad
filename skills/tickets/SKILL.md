---
name: tickets
description: Break a Spec into Tickets and publish them as its GitHub sub-issues, with native blocked_by links.
disable-model-invocation: true
---

This is a Borrowed skill: follow `mattpocock-skills:to-tickets`.

That skill is user-only, so the Skill tool cannot invoke it: read it instead. This prints its path:

    ls ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/*/mattpocock-skills/*/skills/*/to-tickets/SKILL.md | sort -V | tail -1

If it prints nothing, the mattpocock-skills plugin is not installed: stop and say so. Otherwise follow it as written, with verkstad's rules where they differ:

- Write each Ticket in verkstad's [Ticket format](../../docs/formats/ticket.md).
- Publish each Ticket as a native sub-issue of its Spec, and each of its blockers as a native `blocked_by` link, with the `gh api` calls the Ticket format gives. The Frontier reads only these links; the Parent and Blocked by sections repeat them for a reader.
- A Ticket carries no file paths or line numbers: name the behaviour, the types and the commands instead.
- Label each Ticket `ready-for-agent`; the Spec stays open and without that label.
