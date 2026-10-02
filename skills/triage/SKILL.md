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
