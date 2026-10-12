---
name: review
description: Review the changes since a fixed point against the issue they implement, with one subagent. Use when a Ticket's branch is done and needs reviewing before it is reported (fixed point: the commit `git merge-base HEAD origin/<base branch>` prints, run on its own), or when asked to review a branch or the changes since a commit.
---

1. Start one subagent with `run_in_background: false`: a review started in the background returns after you have handed back, and its findings are lost. Give it the fixed point, the Ticket number and this brief:

   > Read the Ticket (`gh issue view <n> --comments`; where a comment disagrees with the body, the latest comment wins) and the diff since the fixed point (`git diff <fixed point>`). Report only:
   > - each acceptance criterion the diff does not meet;
   > - each correctness bug, with how to trigger it;
   > - code the change could delete or not add (an unused option, a wrapper, a re-implemented helper or standard-library call).
   >
   > Report no style points, no naming opinions and no nice-to-haves. If you find nothing, say so; do not invent findings.

2. When it is back, and before you fix anything, run `verkstad review record` on its own in the worktree you reviewed. It records in the log directory that the branch was reviewed, and at which commit. `verkstad land` does not land a Ticket's branch with no recorded review (`reason: review-missing`); the fixes you commit after it keep the record.
