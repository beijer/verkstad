# Addendum: a shared review checklist and `verkstad:audit`

An addendum to [2026-10-12-own-skills.md](2026-10-12-own-skills.md), written while that report is being implemented. Nothing here changes Tickets 1–5. It adds two Tickets to file under the same Spec and run after them.

The owner settled each decision below in the same grilling session. Nothing is left for the implementing session to decide; where this addendum is silent, keep what the report says.

## Why

The report copied only Ponytail's main skill into the implementer and left its other five skills out of scope without reading them. Having now read them:

- **The main rules work on their own.** Ponytail's benchmark measured only that skill, which is all its hooks inject into each session. The other skills are reports a user triggers by hand. Appendix A of the report is complete, and `ponytail-gain` and `ponytail-help` are not needed.
- **There is one link the report missed.** The main rules tell the implementer to mark a deliberate shortcut with a `shortcut: <the limit>, <when to upgrade>` comment. Ticket 3's review brief asks for "code the change could delete", so it would report those comments as findings. `ponytail-review` handles them correctly: a marked shortcut is a decision, not a finding, unless the expected load already exceeds its limit.
- **`ponytail-review` is a better brief than the one in Ticket 3.**
  - It reads callers and tests, not only the diff.
  - It checks in a fixed order: bug, risk, load, missing test, speed, lean.
  - Every finding needs a concrete case: this input leads to this wrong result.
  - It prefers fixes that delete code.
- **`ponytail-audit` is the same method applied to a whole repo.** The owner wants it for every Project, not only for verkstad.

Source for both: [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) at `9b58c1f`, `skills/ponytail-review/SKILL.md` and `skills/ponytail-audit/SKILL.md`, MIT, © 2026 DietrichGebert.

## Decisions

11. **One shared checklist, used by `review` and `audit`.** `skills/audit/checklist.md` holds the two lists the skills share:
    - what to look for;
    - the checks a finding must pass before it is reported.

    Each skill points to it with `${CLAUDE_PLUGIN_ROOT}/skills/audit/checklist.md`, and neither copies the lists. Each skill keeps only its own parts:
    - `review`: its scope (one diff, against a Ticket) and its short output;
    - `audit`: mapping a repo and its full report.
12. **`verkstad:review`'s subagent brief uses the checklist.**
    - It checks the Ticket's acceptance criteria first, then the checklist.
    - Its output is only **Must fix** and **Should fix**. Each finding gives its concrete case and the smallest fix, with no Nice to have, as decision 5 of the report says.
    - It does not use Ponytail's four-part plain-English format, because the implementer reads it, not the owner.
    - It stays one subagent, and everything else in Ticket 3 stands.
13. **A new `verkstad:audit` skill.**
    - It works in any repo, not only a verkstad Project.
    - It is model-invocable: asking to audit a repo or find what to delete starts it.
    - It reads and reports; it changes no code.
    - It keeps Ponytail's report format for the owner:
      - plain English;
      - findings ranked Must fix / Should fix / Nice to have, at most 20;
      - each finding with What this is, Problem, Fix and If we skip it;
      - a verdict, the lean total, and what was not checked.
14. **The audit ends by offering to file findings as issues.** After the report it asks which findings to file, for example "file 1, 3 and 7". Each one the owner picks becomes a GitHub issue labelled `needs-triage`, with the finding's four parts as its body. Nothing is filed without the owner's yes. In a repo with no GitHub remote, it doesn't offer.
15. **No ledger for `shortcut:` comments yet.** Collecting them belongs to the next report, which audits the loop: Landing's closing comment could list the shortcuts a Ticket added. Until then, `git grep "shortcut:"` finds them. `ponytail-debt`, `ponytail-gain` and `ponytail-help` are not copied.

## Ticket 6: the shared checklist and `verkstad:audit`

Blocked by: Ticket 2 (it creates `NOTICE.md`).

**`skills/audit/checklist.md`** (new). Adapted from sections 2 and 3 of `ponytail-audit`, which match those of `ponytail-review`:

- **Look for**, in this order:
  1. Bug: wrong results, crashes, missed edge cases, broken callers, the same rule applied differently in two places.
  2. Risk: security holes and data loss.
  3. Load: fine for one user, wrong at the expected load.
  4. Missing test: risky logic with no test that fails when it breaks. One good test, not coverage.
  5. Speed: real slowdowns.
  6. Lean: delete, reuse, standard library or platform, yagni, merge near-copies, split a function by job (never by line count).
- **Check before you report:**
  - every finding has a concrete case ("this input or situation leads to this wrong result"); no case, no finding;
  - re-read the lines, and grep the whole tree before calling code unused;
  - a `shortcut:` (or older `ponytail:`) comment that names its limit is a decision, not a finding, unless the expected load already crosses it;
  - propose the smallest fix that works, prefer fixes that delete code, and never add layers, frameworks or config the problem does not need;
  - no style taste, no "consider", no vague worries.

The file is shared by both skills and is not a skill itself. It has no frontmatter, and nothing in it names one skill's scope or output.

**`skills/audit/SKILL.md`** (new, model-invocable). Its description says to use it for auditing a repo or a folder, reviewing a whole codebase, finding bloat, or finding what to delete. Its body comes from `ponytail-audit`, with its sections 2 and 3 replaced by "Read `${CLAUDE_PLUGIN_ROOT}/skills/audit/checklist.md` and apply it."

- **Map first** comes from Ponytail:
  - read what the owner names, or the whole repo;
  - README, build and deploy config, dependencies, entry points, tests;
  - find the expected load and say which one was assumed;
  - trace the main flows end to end;
  - in a big repo, go deep where a mistake costs most, and say what was not read.
- In a verkstad Project, it also reads `GLOSSARY.md`, `docs/agents/project.md` and the ADRs, and doesn't report as a finding a choice an ADR records.
- **Output** is Ponytail's section 4, as decision 13 says.
- It then makes the offer in decision 14. Each issue is filed with `gh issue create --label needs-triage`, and is written to the owner as `<owner>/<repo>#<n>`. In a Project, the label comes from `docs/agents/triage-labels.md`.

**`NOTICE.md`:** add a line saying `skills/audit/` and `skills/review/SKILL.md` adapt Ponytail's `ponytail-audit` and `ponytail-review` at `9b58c1f`. Ponytail's MIT licence text is already there from Ticket 2.

## Ticket 7: `verkstad:review` uses the checklist

Blocked by: Ticket 3 and Ticket 6.

Change `skills/review/SKILL.md`'s subagent brief, as written by Ticket 3, so that the subagent:

1. understands the change first:
   - reads the Ticket (`gh issue view <n> --comments`, the latest comment winning where it differs);
   - reads the diff since the fixed point, then the code it touches: the callers of each changed function, the functions it calls, and the tests;
   - greps every caller when a signature, return value or behaviour changes;
2. checks each acceptance criterion against the diff;
3. reads `${CLAUDE_PLUGIN_ROOT}/skills/audit/checklist.md` and applies it to the change;
4. reports only:
   - **Must fix**: an unmet acceptance criterion, a bug, security, data loss, or a break at the expected load;
   - **Should fix**: risky logic without a test, real slowness, duplication, a function that mixes jobs, code that should not exist.

   Each finding is one line, with its concrete case and the smallest fix. If nothing is found, say so.

Remove the brief's earlier "report only" list from Ticket 3; the checklist replaces it. Everything else Ticket 3 wrote stays as it is:
- one subagent, run in the foreground;
- `verkstad review record` before fixing;
- the fixed-point argument;
- no style points.

**`README.md`:** add `/verkstad:audit` to the line of skills Ticket 5 adds.

## Done when

- `skills/audit/` holds `SKILL.md` and `checklist.md`. `skills/review/SKILL.md` points to the checklist and holds none of its lists.
- `git grep -n "Check before you report\|no case, no finding" skills/` finds the checklist only in `skills/audit/checklist.md`.
- The Gate passes.
- In a repo that is not a verkstad Project, "audit this repo" starts `verkstad:audit` without the slash command. It:
  - reports in Ponytail's format, with at most 20 findings;
  - names the load it assumed;
  - offers to file findings and files only those the owner picks, each labelled `needs-triage`.
- A Ticket's review in a Run reports a branch's `shortcut:` comment only when its limit is already crossed. Check this on one implementer transcript, or with a test branch that adds such a comment.

## Out of scope

- A ledger of `shortcut:` comments: this goes to the next report, which audits the loop.
- `ponytail-debt`, `ponytail-gain`, `ponytail-help` and Ponytail's levels.
- Running `verkstad:audit` on verkstad itself: the loop audit does that, as the method for its report.

## Sources

- [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) at `9b58c1f`: `skills/ponytail-review/SKILL.md`, `skills/ponytail-audit/SKILL.md`, `skills/ponytail-debt/SKILL.md`, `hooks/claude-codex-hooks.json`, `benchmarks/results/2026-10-07-agentic.md`
- [2026-10-12-own-skills.md](2026-10-12-own-skills.md), the report this adds to
