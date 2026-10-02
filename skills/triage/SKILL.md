---
name: triage
description: Move issues through the triage labels, and write an Agent Brief for each one made ready for an agent.
disable-model-invocation: true
---

This is a Borrowed skill: follow `mattpocock-skills:triage`.

That skill is user-only, so the Skill tool cannot invoke it: read it instead. This prints its path:

    ls ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/*/mattpocock-skills/*/skills/*/triage/SKILL.md | sort -V | tail -1

If it prints nothing, the mattpocock-skills plugin is not installed: stop and say so. Otherwise follow it as written, reading the files it links from beside it, with verkstad's rules where they differ:

- Use the labels in the Project's `docs/agents/triage-labels.md`.
- Write each Agent Brief in verkstad's [Agent Brief format](../../docs/formats/agent-brief.md).
