---
name: review
description: Review the changes since a fixed point against the repo's standards and against the issue they implement, in two parallel reviews. Use when a Ticket's branch is done and needs reviewing before it is reported (fixed point: the commit `git merge-base HEAD origin/<base branch>` prints, run on its own), or when asked to review a branch or the changes since a commit.
---

This is a Borrowed skill: follow `mattpocock-skills:code-review`.

Invoke it with the Skill tool and follow it as written, passing the same fixed point. Start its two reviews with `run_in_background: false`, in one message, so they run side by side and you get both results before you go on. A review started in the background returns after you have handed back, and its findings are lost.

When both reviews are back, and before you fix anything, run `verkstad review record` on its own in the worktree you reviewed. It records in the log directory that the branch was reviewed, and at which commit. `verkstad land` refuses a Ticket's branch with no recorded review (`reason: review-missing`); the fixes you commit after it keep the record.

This skill only gives it a verkstad name, so that what calls `verkstad:review` keeps working when verkstad writes its own.

If the Skill tool does not know it, the mattpocock-skills plugin is not installed: stop and say so.
