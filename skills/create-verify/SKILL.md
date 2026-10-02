---
name: create-verify
description: Write a Project's Verify skill (`verify-<app>`) with its Doctor, driving tool and seeded Feature map, and prove it with one Walk. Use when asked to create a Verify skill, or to rebuild one a Project already has.
---

# Create a Verify skill

A Verify skill lets an agent that has never seen the Project launch it, check with the Doctor that the instance is worth driving, drive its Surfaces one command at a time and capture Evidence. Its readers are an implementer Walking its own change and the Verifier Walking a Ticket's acceptance criteria. Both come to it in the middle of other work, knowing nothing of the Project and short of context: write for them.

You produce, in the Project, in one commit:

- a driving tool (usually `scripts/<app>`) with a `doctor` command, built on the Project's e2e harness when it has one;
- `.claude/skills/verify-<app>/SKILL.md` with the sections Launch, Doctor, Drive, Evidence, Cleanup and Helpers;
- `.claude/skills/verify-<app>/features/`: the Feature map, seeded.

Nothing is done until step 5 has Walked one feature with the skill as written.

## 1. Interview the repo

Answer each question from the code (package scripts, Makefile, README, CI, the e2e tests and their harness, `docs/agents/`, CONTEXT.md). Ask the owner only what the repo can't tell you.

- **Surfaces.** What does a user or another system observe? The Contract's `surfaces` in `.claude/harness.json` lists them when it exists. For each, how is it observed: text on screen, a DOM attribute, a screenshot, a generated file, a CLI's output, what a fake external system received?
- **Launch.** The Project's own command to build and start it, how long a cold build takes, and what says it is ready (a log line, a port answering).
- **Drive.** The existing e2e harness first: the Verify skill drives the Project the way the e2e tests do, so a Walk turns into an e2e test line for line. Only without one, pick a generic way: WebDriver or a browser for a UI, a PTY or tmux for a CLI or TUI, HTTP for a service.
- **Isolate.** One instance per worktree, on its own ports, config and data, with fakes for external systems. The instance never touches the owner's config, a real device or a production service. If two instances can't run side by side, the skill says so.
- **Built from.** Which paths go into the running instance, and which can't change it (docs, `*.md`, the e2e tests themselves).

If the checkout doesn't build or start as it is, fix that first or report exactly what fails, and write nothing until it starts: every step you would write about it is unchecked.

Done when every answer names a command or a file in this repo.

## 2. Give it a driving tool

Agents drive one command at a time and pay for every line of output. If the Project has no such tool, write one in the Project, on top of its e2e harness. If it has one, add what it lacks from this list:

- `start` builds when needed, launches the instance with its fakes, holds it open (a daemon behind a socket or a port) and prints one line once it is ready. An instance idle for a long time stops itself.
- `stop` ends it, then checks by pid that every process the instance started (the whole tree under it, whatever process group each child leads) is gone, and fails naming any still running.
- Every command answers in a line or two and exits non-zero when it fails.
- A command that can't find what it was asked for fails and prints what is there instead (the buttons, fields and notices on screen; the routes; the files), so the agent takes the real name rather than guessing.
- `look` (or the Surface's equivalent) prints the current state as text, so a screenshot is needed only when the look itself is the point.
- `doctor` is read-only and prints one line per check, exiting non-zero when any fails:
  - **up**: the instance answers.
  - **current**: the instance was built from the code in the worktree now. Just before building, take a fingerprint of the sources (`git rev-parse HEAD` plus the git blob hash of each uncommitted or untracked file) and keep it once the build succeeds; a start that skips the build keeps the last one. At doctor time compare it with the worktree, naming the first changed files and the command that rebuilds. Compare content, not modification times: a checkout touches files without changing them, and a build tool may skip a rebuild. The sources are everything that goes into the instance, the driving tool's own code and the harness it loads included; leave out what can't change it (docs, `*.md`, tests).
  - **dependencies**: each fake or service the instance talks to answers a real question.

`help` is the tool's command reference. The Verify skill points at it rather than copying it.

Done when `doctor` passes on a fresh instance and fails after a source change (step 5 checks both).

## 3. Write the Verify skill

Write `.claude/skills/verify-<app>/SKILL.md` with frontmatter: `name: verify-<app>` and a `description` naming the Project, its Surfaces and when to reach for it (Walking a change before its e2e test, verifying a Ticket's acceptance criteria, asking whether something in the Project works). Then these H2 sections, in this order, each filled from the interview with this repo's real commands, names and paths:

- **Launch.** The command, the Bash timeout a cold build needs, what it prints when ready, one instance per worktree, and that a code change needs a stop and start before it can be seen.
- **Doctor.** The command and what each line checks. Run it after Launch, after any command that failed or surprised, and before reporting a result. What to do when each line fails; a stale instance is restarted, never driven, because a Walk on it proves nothing.
- **Drive.** How to plan a Walk: for each acceptance criterion, what a user does and what they then see, on which Surface. A table from each kind of change to what counts as seen (a control's label, value and state; an attribute; a generated file's content; what a fake received). Then how to act as a user does with the tool's commands, which escape hatches exist for what a user does outside the driving tool's reach (a native file dialog) and that a report names every use of one, the waiting rules, and how to reach a feature: look it up in `features/README.md` and replay the e2e test its Driving it names. Then what follows a Walk: a bug it finds gets a failing test first (`verkstad:tdd`), a restart, the Doctor and the Walk again; and each Walk becomes an e2e test, with each tool command mapped to the harness call it makes, so that what was seen once is checked on every Landing.
- **Evidence.** It goes in the log directory, outside the worktree, because Landing removes the worktree. The Verifier's goes where `verkstad verdict evidence <n>` says (`<log directory>/evidence-<n>/`, which the Ticket's Verdict points at, and which only the Verifier writes); any other Walk's, an implementer's included, in `"$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.claude/verkstad/evidence-$(git branch --show-current)/"`. Per criterion, capture the action and the state it led to: the tool's output saved to a file (with `2>&1`, since a failing command writes to stderr), the generated file or what the fake received, a screenshot when the look is the point. Name each file after its criterion, and show the report line that goes with it (the criterion, what was seen, its Evidence file). Proof standards: whatever a user can do, do it as the user does, through the Surface; a shortcut into the code only where no user path exists, named in the report; a side effect (a file written, what a machine received) checked beside what the screen shows; what depends on something only the real world has (a real device, a production service) goes in the report as not proven.
- **Cleanup.** The stop command, and how to check nothing the instance started is still running: by the processes or process group it started, never by a name pattern that could match someone else's. Cleanup leaves the Evidence where it is.
- **Helpers.** Each script the skill uses, where it lives, how it is invoked and how it is extended: a command the tool lacks is added to it, in the same commit as the feature that needs it.

Keep it short. Facts the Project keeps elsewhere (the tool's `help`, the e2e harness's docs) get a pointer, not a copy.

## 4. Seed the Feature map

Write `features/README.md`: one line per feature linking its file, the state a fresh launch starts from, and the conventions every recipe shares. Then one file per user-facing feature, the 3 to 5 a user meets first (from the UI's main panels, the CLI's commands, the API's routes, CONTEXT.md's glossary). Each file has an H1, one paragraph on what a user can do with the feature, and exactly these four H2s, in this order:

- `## Sub-features`: one line per behaviour, each with a short id.
- `## How to get to it`: every way a user reaches it, as the user sees it.
- `## Driving it`: when an e2e test covers the feature, its path and test names, plus the tool commands that replay it and what to read after each. The test holds the expected values; the map says where to read them, never copies them, so it can't drift from the test. A prose recipe only for what no test covers.
- `## Gotchas`: what wastes a Walk or makes a broken feature look working.

[references/feature-map-example/](references/feature-map-example/) shows the shape. Write what each Driving it says a command shows from a live instance, not from reading the test: launch one (step 3's Launch) and replay each Driving it once. Done when every file has the four sections, every e2e test path it names exists and every Driving it has been replayed on a live instance.

## 5. Walk one feature with it

Follow the new skill word for word, as a reader who knows nothing else would, on one feature from the map:

1. Launch.
2. Doctor passes.
3. Change one source file the instance is built from (append a comment). Doctor fails and names it. Revert the change, touch a source file without changing it, and change a doc; Doctor passes.
4. Walk the feature: replay its Driving it with the tool, observing after each step that matters.
5. Capture Evidence for each step you observed.
6. Clean up. Check the Evidence is still at its path and nothing the Walk started is still running.

Where the skill or the tool was wrong, fix it, clean up and run again from the first step the fix touches (a fix to the tool means a restart: from step 1). Done when every step from 1 to 6 has passed since the last fix.

## 6. When the Project already has a Verify skill

Write the new one beside it in `<log directory>/create-verify/verify-<app>/` and Walk with it there (step 5). Then compare the two: what each says that the other misses, what each gets wrong, which a reader new to the Project follows faster. The merged skill takes the six sections, whatever structure the existing one had, and moves what the existing one does better into them. Write it under the existing skill's name, with the Feature map, and Walk it once more (step 5) on another feature.

## 7. Finish

- Commit the tool, the skill and the Feature map in one commit, in the Project's commit style.
- If the Contract has a `verify` field, it names this skill.
- Report: the skill's path; the features in the map; the feature Walked, with what was seen at each step; the Doctor's stale check, failing and passing; the Evidence path; for a rebuild, what each version did better and what was kept; anything the tool can't reach yet.

Keeping the skill true as the Project changes is `verkstad:maintain-verify`'s job.
