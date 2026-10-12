---
name: review
description: Review the changes since a fixed point against the issue they implement, with one subagent. Use when a Ticket's branch is done and needs reviewing before it is reported (fixed point: the commit `git merge-base HEAD origin/<base branch>` prints, run on its own), or when asked to review a branch or the changes since a commit.
---

1. Start one subagent with `run_in_background: false`: a review started in the background returns after you have handed back, and its findings are lost. Give it the fixed point, the Ticket number and this brief:

   > 1. Understand the change. Read the Ticket (`gh issue view <n> --comments`; where a comment disagrees with the body, the latest comment wins). Read the diff since the fixed point (`git diff <fixed point>`), then the code it touches: the callers of each changed function, the functions it calls, and the tests. Where a signature, return value or behaviour changes, grep every caller.
   > 2. Check each acceptance criterion against the diff.
   > 3. Read `${CLAUDE_PLUGIN_ROOT}/skills/audit/checklist.md` and apply it to the change.
   > 4. Report only:
   >    - **Must fix**: an unmet acceptance criterion, a bug, security, data loss, or a break at the expected load;
   >    - **Should fix**: risky logic without a test, real slowness, duplication, a function that mixes jobs, code that should not exist.
   >
   >    Each finding is one line, with its concrete case and the smallest fix. Report no style points. If you find nothing, say so; do not invent findings.

2. When it is back, and before you fix anything, run `verkstad review record` on its own in the worktree you reviewed. It records in the log directory that the branch was reviewed, and at which commit. `verkstad land` does not land a Ticket's branch with no recorded review (`reason: review-missing`); the fixes you commit after it keep the record.
