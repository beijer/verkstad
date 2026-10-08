# The conflict prompt

For a Ticket whose implementation is done but whose Landing ended in `reason: conflict`. Goes to `verkstad:ticket-light`. Replace `{N}`, `{REPO}` and `{BASE}` as in the implementing prompt, `{COMMITS}` (the branch's commits, `git log --oneline origin/{BASE}..issue-{N}`), `{CONFLICT_FILES}` (from `verkstad land`'s message) and `{LANDED}`: one line per Ticket that landed since issue-{N} branched, with its commits and what it added.

```
You are finishing Ticket #{N} of {REPO}. Your working directory is a git worktree of your own; stay in it. The `verkstad` command is on your PATH.

The Ticket is implemented on branch issue-{N} ({COMMITS}), but landing it failed: rebasing onto origin/{BASE} conflicted in {CONFLICT_FILES}. Since issue-{N} branched, these landed on {BASE}:
{LANDED}

Your job is narrow: rebase and keep both sides' behaviour. Do not redesign or extend either side.
- Read `docs/agents/project.md`, the Project's prose doc, for its stack, its commands and its rules. Where it says how to resolve a conflict in a shared file (regenerate a generated file rather than merge it by hand, keep both entries in a registry), do that.
- `verkstad start {N} --resume`: it fetches, switches to issue-{N}, deletes the branch the worktree came on and rebases onto origin/{BASE}. Resolve the conflicts it names with Skill verkstad:merge-conflicts. Read `gh issue view {N}` and the landed Tickets only as far as you need to know what each side must keep.
- Files can merge without a textual conflict and still break: a switch that must now cover a new case, a union type missing a member, a UI element pushed out of its layout. Check `git diff origin/{BASE}` touches only #{N}'s changes and that {BASE}'s code is intact.
- Run `verkstad gate` until it passes; every test from {BASE} and from issue-{N} must pass. Fixes the rebase needs beyond the conflict go in a commit ending `Refs #{N}`. Leave the worktree clean.
- Do not push, merge, close or comment; Landing lands your branch. Never report something as working that you did not run.

Final report, under 150 words:

status: done | blocked
worktree: <absolute path>
commits: <short hashes on issue-{N} after the rebase>
Resolved: <which files, how, and any fix beyond the conflict>
Gate: passed | failed, with its log's path
Uncertain: <or "none">
```
