---
name: maintain-verify
description: Audit a Project's Verify skill against the Project as it is now. Every Feature-map entry is read against the source and Walked live; map drift and driving-tool gaps are fixed in one change, and app bugs are reported to the owner. Use when asked to audit, maintain or refresh a Verify skill or its Feature map, or when a Walk shows the map is out of date.
---

# Maintain a Verify skill

A Feature map goes stale with every change to the Project, and a stale one sends a Verifier down a path that no longer exists. This skill is the audit that keeps a Verify skill true: every feature in its map is read against the code and its e2e tests, then Walked live with the skill itself. The unit is the feature. Every feature gets both passes; not every sentence of every file gets checked.

It ends with one outcome:

- **`clean`**: every feature had its source pass and its Walk, and the Verify skill needed no fix.
- **`changed`**: the proven fixes went in as one change (one commit, or one pull request).
- **`blocked`**: a pass could not finish, or a fix could not be proven. The report names what blocked it.

Whatever the outcome, the report lists every app bug found.

## What you may change

You change the Verify skill and nothing else: its `SKILL.md`, its `features/`, and the driving tool's own files that its Helpers names (in Ray, `scripts/ray` and `scripts/ray.ts`). The app's source, its e2e tests and the e2e harness belong to the Project. When the app does something other than what the map says, either the map is wrong (you fix the map) or the app is wrong (you report it). Never rewrite the map to match a broken app.

## 0. Find the Verify skill and set up

- The Contract's `verify` field in `.claude/harness.json` names the skill: `.claude/skills/<verify>/`. Without one, look for a single `.claude/skills/verify-*/` whose `SKILL.md` has Launch and Doctor sections and a `features/` directory. If there are several, ask the owner which one. If there is none, stop and point at `verkstad:create-verify`.
- Work in a worktree on its own branch, `maintain-verify-<YYYY-MM-DD>`, from `origin/<baseBranch>`. If a caller gave you a branch (a Ticket's), work there and leave Landing to the caller.
- Your notes and Evidence go in the log directory, under the name the Verify skill's Evidence section gives a branch: `ev="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.claude/verkstad/evidence/<branch>"`. Keep running notes in `$ev/notes.md` (features covered, drift confirmed, what couldn't be reached). They are never committed.

## 1. Check the index

Read `features/README.md` and list `features/`. Every file has a line in the README, every line links a file that exists, and each feature has one file. Then check each file has an H1, a paragraph, and the four H2s in order: `Sub-features`, `How to get to it`, `Driving it`, `Gotchas`. Note what is wrong as drift.

Then look for features the map lacks. Read what changed since the map last did: `git log --oneline <the last commit that touched features/>..HEAD -- <the paths the app is built from>`. A user-facing feature the map doesn't name counts as missing only when you can point at the source file that adds it (a new panel, command, route).

## 2. Source pass: one read-only agent per feature, in parallel

Launch one `Explore` agent per feature file, all in one message so they run at once. Each one reads; none starts the app or edits a file. Give each this prompt, filled in:

```
Read <feature file> in the Verify skill <skill path>, and the Verify skill's SKILL.md.
Compare it with the Project's code and e2e tests as they are now. Read only; do not
start the app, run its tests or change any file. Check:
- Sub-features: does each behaviour still exist? Is there a user-facing behaviour of
  this feature that the file doesn't list?
- How to get to it: do the controls, labels, shortcuts and menus it names exist, with
  that text?
- Driving it: does each e2e test path and test name it names exist? Does each tool
  command it uses exist (`<tool> help`, or the tool's source)? Does what it says to
  read after each step match what the test asserts now?
- Gotchas: is each still true?
Return, in this order:
1. What the feature does, in two sentences, from the code.
2. Its entry points: the source files and e2e tests, with paths.
3. Drift: each place the file disagrees with the code or tests, as
   "<section>: the file says X; <path>:<line> says Y". Or "none".
4. Tool gaps: anything a user can do here that the tool has no command for. Or "none".
5. One Walk: the tool commands that exercise every sub-feature, and what each should show.
```

Done when every feature file has its answer. Then check each claimed drift by reading the line it cites; an agent can misread. Drift in what the app does (as opposed to a renamed test or a moved file) is a suspicion until the live pass sees it.

## 3. Live pass: Walk every feature

Required even when the source pass found nothing: the source shows what the code says, and a Walk shows what the app does. Follow the Verify skill as written, as a reader who knows only it would. Where it is wrong, that is drift.

1. **Launch** as its Launch section says.
2. **Doctor**: it passes before the first command, and again after any command that failed or surprised you. A Doctor that fails because the skill or tool is wrong (a stale check, a wrong command) is drift: fix it, restart, and run it again once. If it still fails, the outcome is `blocked`.
3. **Walk each feature** in the map's order. Return to the Baseline the README names between features (the skill's reset). Replay its Driving it step by step, then the source pass's Walk for any sub-feature the Driving it doesn't reach, observing after every step that matters. Stop at the first command that fails and look before going on: the commands after it ran in a state you didn't mean to be in. Save each observation to `$ev/<feature>-<step>.txt` (with `2>&1`), with a screenshot only when the look is the point.
4. **Sort what you see.** Every step either matches the map or doesn't. A step that doesn't is one of three things:
   - **Map drift**: the map says something the app no longer does, and the app is right. The e2e test agrees with the app, or the change that made the difference was intended (its commit says so). A feature step 1 found missing is drift too. Behaviour the map never claimed to cover is not: the map indexes what a user meets first, not every behaviour, so a sub-feature the source pass found unlisted goes in the report as a candidate rather than into the map.
   - **Driving-tool gap**: the app does the right thing, and the tool can't drive it or reports it wrongly. Examples: a command missing, a wrong name, a wait that's too short, output that hides the state. Only a gap that keeps a sub-feature in the map from being Walked, or makes a step it describes fail, is fixed; the rest go in the report, for the Ticket that needs them to add (the Verify skill's Helpers rule).
   - **App bug**: the app is wrong. If the map and the e2e test agree with each other and not with the app, run that one e2e test. If it fails, it is an app bug. If the test passes, the difference is in the tool or the map. When you can't tell drift from a bug, call it a bug, so the map never covers for a broken app.

   A step that fails once and passes when replayed from the same state is flaky: replay it once more, and report it with both Evidence files as a suspected app bug.
5. A feature you can't reach (it needs a real device, an account, a production service) is recorded as not proven, naming what it needs. If its file doesn't say so, that is drift.

Done when every feature has been Walked, or recorded as not proven with what it needs.

## 4. Fix the drift and the gaps

- **Map drift**: edit the feature file, README or `SKILL.md`. A Driving it points at its e2e test and the values the test holds. Don't copy them into the map.
- **Driving-tool gap**: fix it in the tool, as the Verify skill's Helpers says commands are added (in Ray, a command in `scripts/ray.ts` calling the e2e harness). When the fix needs the harness, the tests or the app changed, it is not yours to make: report it for the owner.
- **App bug**: leave the code alone. For each one, record the feature and sub-feature, the steps, what the test or the Spec expects, what you saw, and its Evidence file.

Prove every fix live before it ships. After a tool fix, stop and start (the Doctor's `current` check demands it), run the Doctor, and Walk again each feature the fix touches. After a map fix, replay the changed Driving it. A fix you can't prove stays out of the change, and goes in the report.

## 5. Clean up

Follow the Verify skill's Cleanup after the last Walk, including the re-Walks. Then check, by the pids it names (never a name pattern), that nothing you started is still running, and that `$ev` still holds the Evidence.

## 6. Land the change and report

- **`clean`**: no commit. Remove the branch and worktree if you made them.
- **`changed`**: re-read every changed file. Then run the Gate (`verkstad gate --quick` from the worktree) and make one commit, in the Project's commit style, that says what is now true of the Verify skill. If a caller gave you its branch, stop there. Otherwise land the commit as the Contract's `landing` says. With `push`, rebase onto `origin/<baseBranch>`, run the full Gate (`verkstad gate`) and push to the base branch. With `pull-request`, push the branch and open one pull request.
- **`blocked`**: proven fixes still go in as one change, as for `changed`. The outcome stays `blocked`, because the audit didn't finish.

Report, short:

- The outcome, and what blocked it if it was blocked.
- Per feature: whether the source pass found drift, and whether it was Walked or not proven (and what it needs).
- Each fix: map drift or tool gap, the file, and what was wrong.
- **App bugs, for the owner**: each with its feature, steps, what was expected, what was seen, and its Evidence file.
- The commit or pull request, and the Evidence directory.
