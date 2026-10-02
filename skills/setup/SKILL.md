---
name: setup
description: Make the repository you are in a verkstad Project, or check one that already is: its agent docs, its Contract, its triage labels on GitHub, then a Gate and a Frontier run to prove them. Use when the owner asks to set up verkstad in a repo.
disable-model-invocation: true
---

# Set up a Project

A Project tells verkstad about itself through its Contract and its agent docs. Setup finds out from the repo everything it can, asks the owner the rest, writes what is missing, creates the triage labels and proves the result with the Gate and the Frontier. On a repo that is already a Project it changes nothing it finds correct, so running it again is a check.

When it is done the Project has:

| What | Where | Format |
| --- | --- | --- |
| The Contract, for the scripts | `.claude/harness.json` | [docs/contract.md](../../docs/contract.md) |
| The Contract, for the agents | `docs/agents/project.md` | [docs/formats/agent-docs.md](../../docs/formats/agent-docs.md#projectmd) |
| The agent docs | `docs/agents/issue-tracker.md`, `triage-labels.md`, `domain.md` | [docs/formats/agent-docs.md](../../docs/formats/agent-docs.md) |
| Pointers to them | `CLAUDE.md`, `## Agent skills` | [docs/formats/agent-docs.md](../../docs/formats/agent-docs.md#the-pointer-in-claudemd) |
| The log directory ignored | `.gitignore`: `.claude/verkstad/` | [docs/contract.md](../../docs/contract.md#the-log-directory) |
| The five triage labels | on GitHub | `verkstad labels` |

The links are relative to this skill's directory in the plugin; read each format before writing the file it governs.

Rules for the whole run:

- **A missing file is written; a file that exists is the Project's.** Read it and run step 2's checks on it. Change it only where a check fails, and only once the owner has agreed. Everything else about it stays as it is: its wording, sections of its own, sections the format has and it lacks. Those differences go in the report as notes.
- **Setup changes nothing outside that table.** Not the Project's code or CI, nothing on GitHub but the labels. It never creates the GitHub repo, pushes, or installs the plugin; those are the owner's.
- `CONTEXT.md` and `docs/adr/` are created when a term or a decision is first settled, not by setup.

Run every `verkstad` command below as `verkstad`; outside Claude Code, where the plugin's `bin/` is not on the PATH, as `${VERKSTAD_HOME:-$HOME/code/verkstad}/bin/verkstad`.

## 1. Look

Work at the root of the Project's main checkout. Stop and tell the owner what to do first when:

- it is not a git repo, or `git status --porcelain` prints anything: setup's commit must hold only its own files;
- `gh repo view --json nameWithOwner` does not name the GitHub repo: the repo and its `origin` come first;
- `git ls-remote --symref origin HEAD` prints no `ref: refs/heads/<branch>` line: `origin` has no commits, and the base branch must be pushed first (`verkstad gate --quick` diffs against it, and every Ticket's worktree starts from it);
- `verkstad help` does not run.

Then find out, changing nothing:

- **The base branch:** the `<branch>` of that `ref: refs/heads/<branch>` line.
- **What is there already:** each file in the table above, each field of `.claude/harness.json`, whether `git check-ignore -q .claude/verkstad/x` succeeds, any Verify skill in `.claude/skills/verify-*/`, and the labels: `verkstad labels --dry-run` reads them and creates none.
- **How it builds and tests:** the lockfile names the package manager (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lock`); then `package.json`'s scripts, a `Makefile` or `justfile`, `Cargo.toml`, `go.mod`, `pyproject.toml`, and the README's development section.
- **What CI runs:** the `run:` steps of each job in `.github/workflows/*.yml` that runs on push or pull request. The Gate is CI without the release build, so CI is its first source.
- **Its Surfaces**, from what the code shows a user or another system:

  | Sign in the repo | Surface | Its globs |
  | --- | --- | --- |
  | `index.html`; a UI framework among the dependencies (React, Vue, Svelte, Solid, Angular); `tauri.conf.json`, Electron | `ui` | the UI's source and the assets it ships |
  | `bin` in `package.json`; a binary target in `Cargo.toml`; `cmd/` in Go; console scripts in `pyproject.toml` | `cli` | the commands' source |
  | a server framework (Express, Fastify, Hono, Koa, Axum, Actix, Flask, FastAPI, Django); route files; an OpenAPI file | `api` | the routes, handlers and the schema |
  | a file the Project writes for someone else to read (a site, a report, a G-code file) | named after the file | the code that writes it |
  | code that talks to hardware (serial, USB, a device on the network) | named after the device | the code that drives it |

  A library with none of these has no Surfaces.
- **Its domain layout:** single-context unless there are monorepo signs (`pnpm-workspace.yaml`, `workspaces` in `package.json`, `packages/*/` with their own sources).

## 2. Check what is there

Run each check on what exists. A failed check is a finding for step 3.

| What | It is correct when |
| --- | --- |
| `.claude/harness.json` | It is valid JSON; `baseBranch` is step 1's base branch; `landing` is absent, `"push"` or `"pull-request"`; `surfaces` is an array, and each Surface's globs match a tracked file (`git ls-files -- '<glob>'`); `verify`, when set, names a skill at `.claude/skills/<verify>/SKILL.md`. The Gate is checked by running it, in step 6. |
| `docs/agents/project.md` | It is not empty. |
| `docs/agents/issue-tracker.md` | It says issues are GitHub issues. |
| `docs/agents/triage-labels.md` | Its middle column maps `ready-for-agent`, `needs-info` and `ready-for-human` to those same strings: verkstad's commands use them as they are. |
| `docs/agents/domain.md` | Its layout (one `CONTEXT.md`, or a `CONTEXT-MAP.md`) is the repo's. |
| `CLAUDE.md` | It has an `## Agent skills` section. |
| `.gitignore` | `git check-ignore -q .claude/verkstad/x` succeeds. |
| The labels | `verkstad labels --dry-run` says `exists` (or `exists as <name>`, the same label in another case) for all five. |

## 3. Draft, then ask

Draft each missing piece from what step 1 found:

- **`baseBranch`:** step 1's base branch.
- **The Gate** (`gate`, in [the Contract's shape](../../docs/contract.md#gate)): CI's `run:` steps in order, without the release build (packaging, publishing, deploying) and without what only a CI runner needs (checking out, installing toolchains, caches). An install step goes first with `unlessExists` (`node_modules`, `.venv`), for a fresh worktree. A slow suite whose test files a branch adds one at a time (e2e) gets `quick`, but only when its command already reads the files from a variable (`node --test $E2E_FILES`, or a script that reads `E2E_FILES`): setup doesn't change the Project's scripts, and a `quick` its command ignores runs the whole suite. Without CI, draft it from the package scripts that check rather than ship (typecheck, lint, test, build). Every command runs from the repo root with the repo's own scripts, so that a step reads the same here as in CI.
- **`landing`:** `"push"`.
- **`surfaces`:** one per sign step 1 found, each a name and its globs, in the shape [docs/contract.md](../../docs/contract.md#surfaces) gives; `[]` with none.
- **`verify`:** the name of a Verify skill the repo has; left out without one.

Ask the owner, with one AskUserQuestion call, the questions the repo did not settle, each with the draft as its first option, marked "(Recommended)". Each is asked only when this run writes the Contract, or when step 2 found that field missing or wrong; a field that passed its check is not asked about.

- **Gate steps**, unless the draft came from CI. Show the steps; offer the draft, and a smaller or larger set when the scripts suggest one.
- **Landing mode:** `push` (Landing pushes the rebased branch to the base branch), or `pull-request`, for a base branch that is protected; `verkstad land` refuses `pull-request` until verkstad supports it.
- **Surfaces**, even when the draft is none: a Surface left out lets a change a user can see land without a Verifier ([ADR 0004](../../docs/adr/0004-verifier-triggered-by-surface-globs.md)). Show each with its globs; offer the draft, and the draft with the doubtful ones left out. A Project with no Surfaces lands its Tickets at most `test-verified`.
- **Domain layout**, only with monorepo signs: single-context or multi-context.

Then show the plan: each file to write, with its content; each fix to an existing file, as a diff, with the check it fails; the labels to create. Ask once more, with AskUserQuestion, whether to go ahead or change something. When the plan is empty, say so and go to step 6.

## 4. Write

Only what the plan lists.

- **`.claude/harness.json`:** the fields in the order `baseBranch`, `landing`, `gate`, `surfaces`, `verify`, as JSON indented by two spaces.
- **`docs/agents/project.md`:** in [its format](../../docs/formats/agent-docs.md#projectmd), with the facts step 1 found. Leave out what you would have to guess; the owner adds it later.
- **The agent docs:** each as the block in [agent-docs.md](../../docs/formats/agent-docs.md) gives it, with this repo's name and three changes: the issue tracker names `verkstad:triage` where the block names the triage skill by a slash name; it ends with the "Specs and blockers" section that format adds; `domain.md` stays generic about which skill creates the glossary and the ADRs.
- **`CLAUDE.md`** (created when missing; verkstad is for Claude Code, which reads it): when it has no `## Agent skills` section, add [the format's](../../docs/formats/agent-docs.md#the-pointer-in-claudemd), with one `###` per agent doc, `project.md`'s last. When the section is there, add a `###` only for a doc this run wrote that it does not point at yet.
- **`.gitignore`** (created when missing): append `.claude/verkstad/`.

## 5. Create the labels

Run `verkstad labels`. It prints one line per label, `created`, `exists` or `failed`, and tries every label even when GitHub refuses one. For a `failed` one, say which and why (its error is on stderr), and go on: the Frontier works without it, but the first Park would fail.

## 6. Prove it

From the repo root:

1. `verkstad gate --quick` ends `Quick gate passed`. When a step fails because its command is wrong here (a script that isn't there, a tool off the PATH), fix the step in the Contract this run wrote and run it again. When the Project itself is red on a clean checkout, or the Contract was there before this run, change nothing: the report says which step failed and its log's path.
2. `verkstad frontier` prints its Ready, In progress and Waiting lists (empty is fine).

Done when both pass, or the report says exactly what fails and why.

## 7. Commit

When step 4 wrote anything, commit exactly those paths (`git add <path>…`, never `-A`), in one commit in the Project's commit style (`git log --oneline`). The Gate may have left files of its own, such as a lockfile from an install step; leave them out of the commit and name them in the report, for the owner to commit or ignore. Don't push. A Ticket's worktree starts from `origin/<baseBranch>`, so the report tells the owner to push before the first Run.

## 8. Offer a Verify skill

When the Contract has Surfaces and no `verify`, ask with AskUserQuestion whether to write the Verify skill now with `verkstad:create-verify` (first option, "(Recommended)") or later. Invoke `verkstad:create-verify` only when the owner says yes. Without Surfaces, don't offer it: no Verifier runs there. When `verify` is set, keeping that skill true is `verkstad:maintain-verify`'s.

## 9. Report

- **Found:** what was there and passed its checks.
- **Written** and **fixed:** each file, and the commit.
- **Labels:** `verkstad labels`'s lines.
- **Proof:** the Gate's pass line (or the failing step and its log), and that the Frontier ran.
- **Notes:** each difference left alone, and what to do about it if the owner wants to.
- **Next:** push the commit; write Tickets with `verkstad:spec` and `verkstad:tickets`, label them `ready-for-agent`, and `verkstad frontier` lists them.
