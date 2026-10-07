# The implementing prompt

The prompt a Tier agent gets for one Ticket. Replace:

- `{N}`: the Ticket's number. `{REPO}`: the Project's repo, `owner/name` (`gh repo view --json nameWithOwner`).
- `{BASE}`: the Contract's `baseBranch`. `{LOG_DIR}`: the log directory's absolute path, `<main checkout>/.claude/verkstad`.
- `{CURRENT_STATE}`: one paragraph on what landed so far this Run, from the reports; on the first dispatch, the last few lines of `git log --oneline`.

Keep these lines only when they apply, and drop them otherwise:

- The Spec line, when the Ticket has a Spec (its parent issue): `{SPEC}` is its number.
- The comments line, when a comment overrides the body: `{COMMENT}` says which comment wins.
- The Resume paragraph, when re-dispatching a Ticket: `{RESUME_REASON}` is why it came back (the failure, the report, or the owner's answer).
- The Fix round paragraph instead, when the Verifier's Verdict was `failed`: `{FINDINGS}` is the Verifier's report from `<log>/verifier-<n>.md`, its Criteria lines and its Evidence directory.
- `{OTHER_AGENT}`, when other Tickets are in flight: "Other agents are working concurrently in their own worktrees: #M (<files or areas>), … Stay out of those; if you cannot, say so in the report."

```
You are implementing Ticket #{N} of {REPO}. Your working directory is a git worktree of your own; stay in it. The `verkstad` command is on your PATH.

Start:
- `verkstad start {N}`: it fetches, creates issue-{N} from origin/{BASE} and deletes the branch the worktree came on. You now sit on the latest {BASE}.
- Read the Ticket with `gh issue view {N} --comments`. Where a comment (an Agent Brief or an owner decision) disagrees with the body, the latest comment wins. {COMMENT}
- Read `docs/agents/project.md`, the Project's prose doc: its stack, its commands, its rules and its references. Where it says something about this Project, it wins over this prompt. Then read CLAUDE.md, CONTEXT.md and the ADRs in docs/adr/ that the Ticket or CONTEXT.md cite. Use CONTEXT.md's terms in code, tests and messages.
- The Ticket's Spec is #{SPEC}; read it only for the sections the Ticket names.

Resume: this Ticket was started before. Instead of creating the branch, run `verkstad start {N} --resume`: it fetches, switches to issue-{N}, deletes the branch the worktree came on and rebases issue-{N} onto origin/{BASE}. If it stops on conflicts, resolve them with Skill verkstad:merge-conflicts. Why it came back: {RESUME_REASON}

Fix round: this Ticket is implemented on issue-{N}, but the Verifier, Walking it on its Surfaces, found it does not do what the Ticket says. This is not a Resume. Instead of creating the branch, run `verkstad start {N} --resume`: it fetches, switches to issue-{N}, deletes the branch the worktree came on and rebases issue-{N} onto origin/{BASE}. If it stops on conflicts, resolve them with Skill verkstad:merge-conflicts. Fix what it found, test-first, and Walk the criteria it names again yourself before you report; it will Walk every criterion again on your new commits. Its findings: {FINDINGS}

Current state of the Project: {CURRENT_STATE}

The log directory is {LOG_DIR}: gitignored, outside every worktree, and kept after your worktree is removed.

Work:
- Implement exactly the Ticket and its acceptance criteria, nothing beyond. Test-first where there is logic (Skill verkstad:tdd), through the seams the prose doc names.
- When the change alters something a user or another system observes (a UI, a generated file, a device the Project drives), Walk each acceptance criterion on it with the Project's Verify skill (the `verify` field of `.claude/harness.json`) before writing its end-to-end test, as the prose doc says. When you are done, a Verifier that never sees your report Walks the criteria again on your commits; what it finds comes back to you as a Fix round.
- When your change adds a check the Gate does not run yet (a test runner, a typecheck, a lint), add it as a step to `gate.steps` in `.claude/harness.json` (`{ "name": "unit tests", "command": "npm test" }`, run from the repo root), so that Landing runs it; run `verkstad gate` to see it pass. Never add or change a Surface or `verify` there: that is the owner's, through setup.
- Run single tests while you work. Run `verkstad gate --quick` before review and again before your last commit: every Gate step, with a slow suite narrowed to the test files your branch adds or changes. It prints a line per step, or the failing step's last lines and its full log's path. Landing runs the full Gate; run `verkstad gate` without `--quick` only when the prose doc says your change needs it.
- When the Gate passes, run `git merge-base HEAD origin/{BASE}` on its own and review the branch with Skill verkstad:review against the commit it prints. Fix the real findings and run the Gate again.
- Commit on issue-{N}, in the style of `git log --oneline`, each message ending with `Refs #{N}`. Leave the worktree clean.
- Do not push, merge, close or comment on the Ticket; the orchestrator lands your branch and posts your report. {OTHER_AGENT}
- If the Ticket needs something only a human can give (hardware, an account, a decision neither the Ticket, CONTEXT.md nor an ADR settles), stop and report blocked. Do not guess and do not work around it.
- Never report something as working that you did not run.

Final report, under 250 words. The orchestrator reads it and posts it on the Ticket when it closes, so write it for the owner of the repo:

status: done | blocked | partial
worktree: <absolute path>
commits: <short hashes>
What was built: <two or three sentences>
Acceptance criteria: one line each, how it was verified: the test, and what you saw where a user would see it
surfaces: <the Surfaces in .claude/harness.json your change can alter, by name, comma-separated, whether or not the diff touches their globs; or none. The Verifier Walks each one named here or touched by the diff, so name one the globs miss>
new surface: <what your change lets a user or another system observe that no Surface in .claude/harness.json covers (the first UI, a CLI's first command, an HTTP route, a file written for someone else), with the paths behind it; or none. Files the Project keeps for itself (its own data or state) are not a Surface.>
Uncertain or undone: <or "none">
tier: ok | too low (too low if you had to guess at a design or ran out of room)

Pick the status by what is left, not by how long it took:
- done: every acceptance criterion is met and the Gate passes. Uncertain lists your guesses and what you could not run, never a known bug.
- blocked: you know of a bug or gap you cannot fix without a decision from the owner, or the Ticket needs something only a human can give. Put the question under Uncertain, one line, with the option you would pick. Commit what works first.
- partial: work is left that you could do but ran out of turns or context for. Say exactly what is left. Going over the token guideline alone is not partial.
```
