---
name: review
description: Review the changes since a fixed point against the repo's standards and against the issue they implement, in two parallel reviews. Use when a Ticket's branch is done and needs reviewing before it is reported (fixed point `git merge-base HEAD origin/<base branch>`), or when asked to review a branch or the changes since a commit.
---

This is a Borrowed skill: follow `mattpocock-skills:code-review`.

Invoke it with the Skill tool and follow it as written, passing the same fixed point. This skill only gives it a verkstad name, so that what calls `verkstad:review` keeps working when verkstad writes its own.

If the Skill tool does not know it, the mattpocock-skills plugin is not installed: stop and say so.
