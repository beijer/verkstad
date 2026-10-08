---
name: maintain-verify
description: Audit a Project's Verify skill against the Project as it is now. Every Feature-map entry is read against the source and Walked live; map drift and driving-tool gaps are fixed, and the removals the owner approves (Surface globs that match too much, features that only repeat an e2e test, features the Project no longer has) are made, in one change; app bugs are reported to the owner. Use when asked to audit, maintain or refresh a Verify skill or its Feature map, or when a Walk shows the map is out of date.
---

# Maintain a Verify skill

A Feature map goes stale with every change to the Project, and a stale one sends a Verifier down a path that no longer exists. This skill is the audit that keeps a Verify skill true: every feature in its map is read against the code and its e2e tests, then Walked live with the skill itself. The unit is the feature. Every feature gets both passes; not every sentence of every file gets checked.

A Verify skill and the Surfaces only grow unless something prunes them, and each costs on every Ticket: a glob that matches too much sends a Verifier to Walk a change no user can see, and a feature whose Walk only repeats its e2e test makes every Walk longer for nothing. So the audit also asks whether each verification still earns its cost, and proposes removing the ones that don't. The goal is a lean Verify skill: fewer, sharper features over many shallow ones. Nothing is removed without the owner's approval.

It ends with one outcome:

- **`clean`**: every feature had its source pass and its Walk (or is not proven for a reason its file names, see step 3), and the Verify skill needed no fix.
- **`changed`**: the same coverage, and the proven fixes and the approved removals went in as one change (one commit, or one pull request).
- **`blocked`**: a pass could not finish, or a fix could not be proven. The report names what blocked it.

Whatever the outcome, the report lists every app bug found: a bug in the Project itself, not in its Verify skill.

## What you may change

You change the Verify skill: its `SKILL.md`, its `features/`, and the driving tool's own files that its Helpers names. In the Contract you change only the Surfaces, and only by a narrowing the owner approved in step 5. The Project's source, its e2e tests and the e2e harness are not yours to change. When the instance does something other than what the map says, either the map is wrong (you fix the map) or the Project is wrong (you report it). Never rewrite the map to match a broken Project.

## 0. Find the Verify skill and set up

- The Contract's `verify` field in `.claude/harness.json` names the skill: `.claude/skills/<verify>/`. Without one, look for a single `.claude/skills/verify-*/` whose `SKILL.md` has Launch and Doctor sections and a `features/` directory. If there are several, ask the owner which one. If there is none, stop and point at `verkstad:create-verify`.
- Work in a worktree on its own branch, `maintain-verify-<YYYY-MM-DD>`, from `origin/<baseBranch>`. If a caller gave you a branch (a Ticket's), work there instead.
- Your notes and Evidence go where the Verify skill's Evidence section puts them: for a Walk that is not the Verifier's, `ev="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.claude/verkstad/evidence-$(git branch --show-current)"; mkdir -p "$ev"`. The Ticket's own `evidence-<n>/` is the Verifier's alone. Keep running notes in `$ev/notes.md` (features covered, drift confirmed, what couldn't be reached). They are never committed.

## 1. Check the index

Read `features/README.md` and list `features/`. Every file has a line in the README, every line links a file that exists, and each feature has one file. Then check each file has the shape `verkstad:create-verify`'s step 4 gives a feature file. Note what is wrong as drift.

Then look for features the map lacks. Read what changed since the map last did: `git log --oneline <the last commit that touched features/>..HEAD -- <the paths the instance is built from>`. A user-facing feature the map doesn't name counts as missing only when you can point at the source file that adds it (a new panel, command, route).

Write down how big the Verify skill and the Contract are now, for the report: the features (the files in `features/` besides the README), the sub-features (the lines under each file's `## Sub-features`) and the globs (every entry of every Surface's `globs` in `.claude/harness.json`, `!` globs included).

## 2. Source pass: one read-only agent per feature, in parallel

Launch one `Explore` agent per feature file, all in one message so they run at once. Each one reads; none starts the Project or edits a file. Give each this prompt, filled in, and save each answer to `$ev/<feature>-source.md`:

```
Read <feature file> in the Verify skill <skill path>, and the Verify skill's SKILL.md.
Compare it with the Project's code and e2e tests as they are now. Read only; do not
start the Project, run its tests or change any file. Check:
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

Done when every feature file has its answer. Then check each claimed drift by reading the line it cites; an agent can misread. Drift in what the Project does (as opposed to a renamed test or a moved file) is a suspicion until the live pass sees it.

## 3. Live pass: Walk every feature

Required even when the source pass found nothing: the source shows what the code says, and a Walk shows what the instance does. Follow the Verify skill as written, as a reader who knows only it would. Where it is wrong, that is drift.

1. **Launch** as its Launch section says.
2. **Doctor**: it passes before the first command, and again after any command that failed or surprised you. A Doctor that fails because the skill or tool is wrong (a stale check, a wrong command) is drift: fix it, restart, and run it again once. If it still fails, the outcome is `blocked`.
3. **Walk each feature** in the map's order. Return to the Baseline the README names between features (the skill's reset). Replay its Driving it step by step, then the source pass's Walk for any sub-feature the Driving it doesn't reach, observing after every step that matters. Stop at the first command that fails and look before going on: the commands after it ran in a state you didn't mean to be in. Save each observation to `$ev/<feature>-<step>.txt` (with `2>&1`), with a screenshot only when the look is the point.
4. **Sort what you see.** Every step either matches the map or doesn't. A step that doesn't is one of three things:
   - **Map drift**: the map says something the Project no longer does, and the Project is right. The e2e test agrees with the instance, or the change that made the difference was intended (its commit says so). A feature step 1 found missing is drift too. Behaviour the map never claimed to cover is not: the map indexes what a user meets first, not every behaviour, so a sub-feature the source pass found unlisted goes in the report as a candidate rather than into the map.
   - **Driving-tool gap**: the Project does the right thing, and the tool can't drive it or reports it wrongly. Examples: a command missing, a wrong name, a wait that's too short, output that hides the state. A gap that keeps a sub-feature in the map from being Walked, or makes a step it describes fail, is fixed. Any other gap goes in the report: the Ticket that first needs it adds it, as the Verify skill's Helpers says, so the tool grows with what is Walked rather than with guesses.
   - **App bug**: the Project is wrong. If the map and the e2e test agree with each other and not with the instance, run that one e2e test. If it fails, it is an app bug. If the test passes, the difference is in the tool or the map. When you can't tell drift from a bug, call it a bug, so the map never covers for a broken Project.

   A step that fails once and passes when replayed from the same state is flaky: replay it once more, and report it with both Evidence files as a suspected app bug.
5. A feature you can't reach (it needs a real device, an account, a production service) is recorded as not proven, naming what it needs. If its file doesn't say so, that is drift; once its file says so, it doesn't keep the outcome from `clean` or `changed`.

Done when every feature has been Walked, or recorded as not proven with what it needs.

## 4. Fix the drift and the gaps

- **Map drift**: edit the feature file, README or `SKILL.md`, keeping to `verkstad:create-verify`'s step 4 (a Driving it points at the test's values, never copies them). A feature or sub-feature the Project no longer has is not edited out here: step 5 proposes its removal.
- **Driving-tool gap**: fix it in the tool, adding a command the way the Verify skill's Helpers says. When the fix needs the harness, the tests or the Project's source changed, it is not yours to make: report it for the owner.
- **App bug**: leave the code alone. For each one, record the feature and sub-feature, the steps, what the test or the Spec expects, what you saw, and its Evidence file.

Prove every fix live before it lands. After a tool fix, stop and start (the Doctor's `current` check demands it), run the Doctor, and Walk again each feature the fix touches. After a map fix, replay the changed Driving it. A fix you can't prove stays out of the change, and goes in the report.

## 5. Propose what to remove

With the passes done, look for what no longer earns its cost. Read the evidence first: the Verdicts (`verdict-<n>.json`) and the Runs' event logs (`run-*.jsonl`, each Park's reason in its `parked` field) in the log directory, `$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.claude/verkstad/`, which keeps 30 days; and, for further back, the Tickets' comments (`gh issue list --state all --search "match too much in:comments" --json number,title`, then `gh issue view <n> --comments`). Three kinds of removal, each with its evidence:

- **A glob that matches too much.** A Ticket whose diff touched a Surface but whose Verdict found no criterion to Walk on it: a `test-verified` Verdict, or a Park asking whether the Surface's globs match too much. For each such Ticket, list the paths its diff changed that the Surface's globs match (`git show --stat` on its commits, or on its pushed branch for a Parked one), and find what they share that no user can see (a test helper, a doc, a build script). Propose the narrower glob, or the `!` glob, that would have kept those paths out, naming the Tickets and their Verdicts or Park reasons. Check it with `git ls-files -- ':(glob)<glob>'` against the old glob: a narrowing that would also drop a path a user can see (one a `live-verified` Verdict's Walk depended on) is not proposed. One Ticket is a weak case, and the proposal says so.
- **A feature or sub-feature that adds nothing.** One whose Walk in step 3 only repeated what its e2e test already asserts, step for step, so the Gate checks it on every Landing anyway, and which has never found anything the Gate would not: no `failed` Verdict, Fix round or app bug in the log directory, the Tickets' comments or the feature file's `git log` names it. The evidence is the e2e test's path and name, and the steps it shares with the Walk. A feature whose Walk sees what the test can't (a look, a real device, a timing) stays.
- **A feature or sub-feature for what is gone.** One the source pass and the Walk found the Project no longer has: the drift step 4 left alone. The evidence is the source pass's line and the commit that removed it.

List the proposals, then ask about each one with AskUserQuestion, one question per proposal (up to four per call): remove it, or skip it. Apply only the approved ones, exactly as approved:

- a feature: delete its file and its README line; a sub-feature: delete its line and every step of the file that only it needed;
- a glob: change that Surface's `globs` in `.claude/harness.json`, and nothing else in it. This narrowing is the owner's own change: it lands with the audit's change below, never through `verkstad land`, whose `contract-narrowed` refusal is for Ticket branches. When a caller gave you a Ticket's branch, leave the Contract alone and report the approved narrowing for the owner to make on a branch of its own.

Prove each removal: `features/README.md` and the files still check as in step 1, every Driving it a removal touched replays, and `verkstad surfaces origin/<baseBranch>` still reads the Contract without failing. List each skipped proposal, with its evidence, in the report. Count the features, sub-features and globs again for the report.

## 6. Clean up

Follow the Verify skill's Cleanup after the last Walk, including the re-Walks. Then check, by the pids it names (never a name pattern), that nothing you started is still running, and that `$ev` still holds the Evidence.

## 7. Hand over the change and report

- **`clean`**: no commit. Remove the branch and worktree if you made them.
- **`changed`**: re-read every changed file. Then run the Gate (`verkstad gate --quick` from the worktree) and make one commit, in the Project's commit style, that says what is now true of the Verify skill and, after an approved narrowing, of the Surfaces. If a caller gave you its branch, stop there: the caller lands it. Otherwise, with the Contract's `landing` at `pull-request`, push the branch and open one pull request for it; with `push`, leave the commit on its branch for the owner to land. `verkstad land` lands Tickets, and only it pushes to the base branch.
- **`blocked`**: proven fixes still go in as one change, as for `changed`. The outcome stays `blocked`, because the audit didn't finish.

Report, short:

- The outcome, and what blocked it if it was blocked.
- How many features, sub-features and globs the Verify skill and the Contract have, before and after.
- Per feature: whether the source pass found drift, and whether it was Walked or not proven (and what it needs).
- Each fix: map drift or tool gap, the file, and what was wrong.
- Each removal: approved and made, or skipped, with its kind and its evidence.
- **App bugs, for the owner**: each with its feature, steps, what was expected, what was seen, and its Evidence file.
- Tool gaps and sub-feature candidates left for later.
- The branch, commit or pull request, and the Evidence directory.
