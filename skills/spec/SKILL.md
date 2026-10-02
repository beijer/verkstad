---
name: spec
description: Turn the conversation so far into a Spec and publish it as a GitHub issue.
disable-model-invocation: true
---

This is a Borrowed skill: follow `mattpocock-skills:to-spec`.

That skill is user-only, so the Skill tool cannot invoke it: read it instead. This prints its path:

    ls ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/*/mattpocock-skills/*/skills/*/to-spec/SKILL.md | sort -V | tail -1

If it prints nothing, the mattpocock-skills plugin is not installed: stop and say so. Otherwise follow it as written, with one verkstad rule where they differ:

- Publish the Spec without the `ready-for-agent` label. A Spec is never implemented directly; its Tickets, written next with `verkstad:tickets`, carry that label as its sub-issues.
