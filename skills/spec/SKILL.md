---
name: spec
description: Turn the conversation so far into a Spec and publish it as a GitHub issue. Use when a whole piece of work has been talked through and should become a Spec for its Tickets to hang off.
disable-model-invocation: true
---

This is a Borrowed skill: follow `mattpocock-skills:to-spec`.

That skill is user-only, so the Skill tool cannot invoke it: read it instead. This prints its path:

    ls ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/*/mattpocock-skills/*/skills/*/to-spec/SKILL.md | sort -V | tail -1

If it prints nothing, the mattpocock-skills plugin is not installed: stop and say so. Otherwise follow it as written, with verkstad's rules where they differ:

- The Project's issue tracker is described in its `docs/agents/issue-tracker.md` and its labels in `docs/agents/triage-labels.md`; where the skill says to run a setup skill for them, read those instead.
- Publish the Spec without the `ready-for-agent` label. A Spec is never implemented directly; its Tickets, written next with `verkstad:tickets`, carry that label as its sub-issues.
- Each issue you show the owner is written `<owner>/<repo>#<n>`, with `<owner>/<repo>` from `gh repo view --json nameWithOwner`.
