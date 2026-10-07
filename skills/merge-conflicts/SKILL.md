---
name: merge-conflicts
description: Resolve a git merge or rebase that stopped on conflicts, keeping both sides' intent, then finish it. Use when a merge or rebase is in progress with conflicts, such as a Ticket's branch rebased onto the latest base branch.
---

Resolve a merge or rebase that stopped on conflicts, keeping what each side meant, then finish it.

1. `git status` names the conflicted files. For each one, read what each side did to it: during a rebase, `git show REBASE_HEAD -- <file>` is the branch's commit being replayed and `git log -p $(git merge-base REBASE_HEAD HEAD)..HEAD -- <file>` what the base did since; during a merge, `git log -p --merge -- <file>`. Then read the conflict hunks themselves.
2. Keep both sides' intent. Where both add to a list, a registry, an import block, a constructor's arguments or an index (the protocol's commands, a Plugin list, a Feature map, a checklist), keep both entries, in the order the file already uses. Where both change the same logic, write the version that does what each side's commit message and tests say; when that cannot be done without a decision neither side settles, stop and say which hunk and why.
3. `git add <file>` for each, then `git rebase --continue` (or `git commit` for a merge), and repeat until it is done.
4. Check the result: `git diff origin/<base>` touches only the branch's own changes, and the base's code is intact. Files can merge without a textual conflict and still break (a constructor taking a new argument from each side, a union type missing a member, a switch missing a case): run the Gate before saying it is done.
