# The Verdict

A Verdict is the Verifier's result for one Ticket: how far the Ticket was proven, the patch it was given for, and what was seen for each acceptance criterion. It is a file in the log directory, written by `verkstad verdict record` and read by `verkstad verdict check` and Landing. Nobody writes it by hand, and nobody computes its patch-id by hand.

## Where it lives

In the log directory, `<main checkout>/.claude/verkstad/` (docs/contract.md), outside every worktree, so Landing, which removes the worktree, keeps it:

- `verdict-<n>.json`: Ticket `#<n>`'s Verdict. Recording a new one replaces it.
- `evidence-<n>/`: the Evidence its Walk captured (screenshots, output, generated files). `verkstad verdict evidence <n>` creates it and prints its path, for the Verifier to save into before it records the Verdict.

`verkstad prune` deletes both once they are 30 days old.

## The file

```json
{
  "ticket": 7,
  "state": "live-verified",
  "patchId": "3f1c0a9d2b7e4c18a6f5d0e9b8c7a6f5e4d3c2b1",
  "criteria": [
    { "criterion": "The panel shows the job's time", "seen": "Opened the panel: it read 3 min 12 s." },
    { "criterion": "Export saves an SVG", "seen": "Clicked Export; out.svg opened with both layers." }
  ],
  "evidence": "/home/me/code/app/.claude/verkstad/evidence-7",
  "recordedAt": "2026-10-02T09:14:03.512Z"
}
```

- `ticket`: the Ticket's number.
- `state`: the Verification state: `live-verified` (seen working on its Surface), `test-verified` (proven by its tests only), `blocked` (needs a human, e.g. real hardware) or `failed`.
- `patchId`: the patch-id of the diff the Verdict was given for: the branch's committed changes since it left `origin/<baseBranch>`, `git diff $(git merge-base origin/<baseBranch> HEAD) HEAD | git patch-id --stable`. `verkstad` spells out the diff's options, so that a user's diff configuration cannot give one patch two ids, and adds `--binary`, so that a change to a binary file changes the id; for a branch without binary files, under git's default configuration, the plain command above gives the same id.
- `criteria`: one entry per acceptance criterion, in the Ticket's order: the `criterion` and what was `seen` when it was Walked. For a `failed` or `blocked` Verdict, what was seen says what went wrong or what a human must check.
- `evidence`: the Evidence directory, an absolute path.
- `recordedAt`: when the Verdict was recorded, an ISO 8601 time in UTC.

## Recording it

```sh
verkstad verdict evidence 7    # prints the Evidence directory; save into it while Walking
verkstad verdict record 7 <worktree> --state live-verified --criteria <file>
```

`<file>` is a JSON array of `{ "criterion": …, "seen": … }`, one per acceptance criterion, each non-empty. `record` refuses a worktree that is not on the branch `issue-<n>`, that has uncommitted changes to tracked files (so what was Walked is not the branch's patch), or whose branch has no changes since it left `origin/<baseBranch>`; a bad state or criteria file is refused too. Otherwise it writes `verdict-<n>.json`, creates `evidence-<n>/` and prints the state, the patch-id's first 12 characters and the file's path.

## Checking it

`verkstad verdict check <n> <worktree>` decides whether Ticket `#<n>`'s branch, checked out at `<worktree>`, may land. It counts the branch's changes from where it left `origin/<baseBranch>`, as last fetched, and:

- passes when the branch touches no Surface (`verkstad surfaces`, docs/contract.md), with or without a Verdict, whatever its state;
- otherwise passes only when the Verdict's patch-id is the branch's patch-id and its state is `live-verified`.

A Verdict holds while the patch-id is unchanged (ADR 0005). A clean rebase onto a base that moved changes every commit but not the patch, so the Verdict still holds. A conflict whose resolution changed the patch, or a new commit such as a Fix round's, voids it, whatever its state, and the Ticket is verified again.

On a pass it prints why and exits 0. On a failure it prints why on stderr and a last line `reason: <code>`, and exits 1:

| Reason | Why |
| --- | --- |
| `verdict-missing` | The branch touches a Surface and the Ticket has no Verdict, or its file is malformed (it names what is wrong). |
| `verdict-void` | The branch touches a Surface and its Verdict was given for another patch. |
| `verdict-not-live` | The branch touches a Surface and its Verdict for this patch is `test-verified`, `blocked` or `failed`. |

Landing runs the same check after its Gate and fails with the same reason (docs/contract.md), keeping the rebased branch in its worktree. A Landing that passes it closes the Ticket with its Verification state after the report, and the Verdict for the landed patch, if there is one, with its Evidence directory and a line per criterion; in the `pull-request` Landing mode the pull request's body carries them instead. Only a `live-verified` Verdict makes it more than `test-verified`.

The check knows only the Surfaces whose globs the diff matches. A Surface the implementer's report names, which the globs miss, is the Run's to add (ADR 0004): it runs the Verifier for it, but `land` does not hold the Ticket to that Verdict.
