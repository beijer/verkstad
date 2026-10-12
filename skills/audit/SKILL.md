---
name: audit
description: Audit a whole repo or a folder for bugs, security holes, what breaks at the expected load, risky code without tests, slow paths, and what to delete, merge or split; ranked, in plain English, changing no code, then offer to file the findings as issues. Use when asked to audit a repo or a folder, review a whole codebase, find bloat, or find what to delete.
---

# Audit

Audit the repo like the senior developer who just inherited it and will be paged when it breaks. Order of importance: correct, safe, holds at the expected load, tested, fast, lean. Lean still matters: every extra line must be read, tested and fixed later. This is a report the owner asked for, so give it in full. It works in any repo, and it changes no code.

## 1. Map first

- Audit what the owner names: a folder, a package, or the whole repo. Nothing named: the whole repo.
- Read the README, the build and deploy config, the dependency list, the entry points (main, routes, handlers, jobs, CLI commands) and the tests.
- Find the expected load: one person running a script, or many users and processes at once. Judge scale against it, and say which load you assumed.
- Trace the main flows end to end: where data comes in, what is stored, what goes out. Read those paths fully: input from users, money, auth, data writes, background jobs, anything shared between processes.
- Big repo: go deep where a mistake costs the most, not file by file. Say which parts you did not read.
- In a verkstad Project (it has `.claude/harness.json` and `docs/agents/project.md`), also read `GLOSSARY.md`, `docs/agents/project.md` and the ADRs in `docs/adr/`. A choice an ADR records is not a finding.

## 2. What to look for

Read `${CLAUDE_PLUGIN_ROOT}/skills/audit/checklist.md` and apply it.

## 3. Report

Very simple English: short sentences, everyday words. Explain a technical term the first time you use it. The reader may never have seen this code.

Start with `What this repo does:` in two or three sentences, and the load you assumed.

Then the findings in three groups, most important first, skipping empty groups:

- **Must fix:** a bug, security, data loss, a break at the expected load.
- **Should fix:** risky code without a test, real slowness, duplication, a function that mixes jobs, code that should not exist.
- **Nice to have:** small speed-ups, shorter forms.

Number the findings across all groups, so the owner can say "file 2 and 5". At most 20 findings; if you left smaller ones out, say how many. Every finding has all four parts, each one or two short sentences:

2. **Orders land on the wrong day** (`billing/close_day.py:L40-52`)
   - **What this is:** At midnight this job closes the day and bills all orders of that day.
   - **Problem:** It takes "today" from the server clock, which runs in UTC. An order placed at 00:30 in Berlin is billed on the day before.
   - **Fix:** Compute the day once in the shop's time zone: `datetime.now(ZoneInfo("Europe/Berlin")).date()`. One line, nothing else changes.
   - **If we skip it:** Late orders show the wrong date, and accounting fixes them by hand.

End with:

- `Verdict:` one line: healthy, or what to fix first.
- `Lean: -<N> lines, -<M> dependencies possible.` when lean findings exist.
- `Not checked:` the parts you did not read or could not run.

Nothing found: `What this repo does:`, then `Healthy. Nothing to fix.` and one line on what you checked.

## 4. Offer to file the findings

When the repo has a GitHub remote (`gh repo view --json nameWithOwner` answers), end by asking which findings to file as issues, for example "file 1, 3 and 7". With no GitHub remote, don't offer.

**Nothing is filed without the owner's yes.** File only the findings the owner picks, each with `gh issue create --label needs-triage`: its title the finding's title, its body the finding's four parts. In a verkstad Project, the label is the string `docs/agents/triage-labels.md` gives for `needs-triage`. Name each issue filed to the owner as `<owner>/<repo>#<n>`.
