# verkstad's skills become its own

verkstad currently borrows six skills from `mattpocock-skills`: `spec`, `tickets`, `triage`, `tdd`, `review` and `diagnose`. Each is a thin wrapper that tells the agent to follow Matt Pocock's skill. That was the plan in ADR 0002: borrow first, then replace each one once verkstad knows what it needs. It now knows.

This report replaces the borrowed skills, deletes the ones Opus 5.5 no longer needs, and puts the Ponytail rules into the implementer's system prompt. It also gives verkstad its own Spec format, tightens the Ticket and Agent Brief formats, and renames the glossary to `GLOSSARY.md`.

The owner settled every decision below in a grilling session on 2026-10-12. Nothing here is left open for the implementing session to decide; where this report is silent, keep what verkstad does today.

`verkstad run`, Landing, the Verifier and the sidebar are out of scope. A second report will audit the loop for what can go.

## Why

**The borrowed skills fight verkstad.**
- Matt's `tdd` requires the agent to confirm test seams with the user before it writes any test. A headless implementer has no user to ask.
- Matt's `tdd` and grilling skills read `GLOSSARY.md`, while verkstad's formats say `CONTEXT.md`.
- `to-spec` labels the Spec `ready-for-agent`, which verkstad's wrapper has to override.
- The wrappers find Matt's SKILL.md through an `ls` glob into the plugin cache, which breaks whenever he renames something. Since July he has renamed `to-prd` to `to-spec`, merged `to-issues` into `to-tickets`, and renamed `CONTEXT.md` to `GLOSSARY.md`. On 2026-10-06 he froze the repo to new skills ([mattpocock/skills](https://github.com/mattpocock/skills) at `49dd158`).
- Most of what matters in verkstad's wrappers is the verkstad rules they add on top. The borrowed text is mostly packaging around those rules.

**Opus 5.5 needs less scaffolding.**
- Anthropic's Opus 5 prompting guide says to remove "verify before finishing" instructions and self-spawned verification subagents, because they add cost without improving quality.
- The same guide says delegating multiplies cost on small tasks.
- Anthropic's harness-design post: every part of a harness encodes an assumption about what the model can't do, and should be re-tested as models improve.
- So:
  - `diagnose` (138 lines) goes, because Opus 5.5 debugs well without a procedure.
  - `tdd` goes. Matt himself now says he has mixed feelings about TDD with agents and mostly asks them for proof that the code works.
  - `review` keeps one reviewer instead of two.

**Ponytail has evidence behind it.**
- Ponytail 5 ([DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail), MIT, `9b58c1f`) is a 52-line skill. Most of its plugin is three hooks that re-inject that skill every session.
- Its benchmark ran 39 tasks, 5 runs each, on Opus 5.5 in headless Claude Code, against the same agent with no skill (`benchmarks/results/2026-10-07-agentic.md`). It reports:
  - 26% lower cost, 41% less time and 53% less code;
  - risky logic shipped with a test 98% of the time, against 68% without it.
- verkstad needs it only where code is written in a Run, and the implementer's system prompt already reaches every one of those sessions.

**Specs and Tickets: what the research found.** There is little hard evidence; what exists points the same way.
- A small study removed one spec section at a time (5 tasks, about 2,700 runs). Concrete behaviour scenarios mattered most; abstract "success criteria" and entity sections did almost nothing ([alphaxiv 2608.25399](https://www.alphaxiv.org/abs/2608.25399)).
- A study of 3,180 Copilot PRs found issues merged more often when they were self-contained, small and spelled out the expected and edge-case behaviour. Longer issues, and issues that depended on setup, merged less ([arXiv 2512.21426](https://arxiv.org/html/2512.21426v1)).
- Critiques of spec-driven development point at long user-story lists and spec bloat ([Böckeler](https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html); [Thoughtworks Radar](https://www.thoughtworks.com/radar/techniques/spec-driven-development)).
- Anthropic's harnesses write acceptance criteria as user-level steps that a separate evaluator checks on the live app ([Effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents); [Harness design](https://www.anthropic.com/engineering/harness-design-long-running-apps)).
- verkstad's Ticket format already matches most of this. Its gaps are a place for decisions, an out-of-scope section, and criteria worded as an action and what is then seen.

## Decisions

1. **Matt's skills go completely, in one change set.**
   - All six Borrowed skills are replaced or deleted.
   - `scripts/check-borrowed.sh`, the Gate's `borrowed` step and the term "Borrowed skill" go.
   - ADR 0009 supersedes ADR 0002.
   - The owner uninstalls the `mattpocock-skills` plugin once the last Ticket lands.
2. **Ponytail's core rules are copied verbatim into the body of `agents/implementer.md`.**
   - No hook, no skill, no levels, no off switch.
   - They apply in every Run's implementer session and nowhere else.
   - The owner uninstalls the Ponytail plugin.
3. **`verkstad:tdd` is deleted with nothing moved from it.** The implementing prompt's testing line becomes: "Prove new logic with a test, through the seams `docs/agents/project.md` names." There is no test-first rule. Ponytail's own rule (non-trivial logic leaves a small test) covers the rest. verkstad's own CLAUDE.md keeps its test-first convention, because that is how verkstad itself is built.
4. **`verkstad:diagnose` is deleted with no replacement.**
5. **`verkstad:review` becomes verkstad's own, with one reviewer.** It runs one fresh-context subagent. The subagent reports only:
   - acceptance criteria the diff does not meet;
   - correctness bugs;
   - code that could be deleted.

   It reports no style points and no nice-to-haves. `verkstad review record` and Landing's `review-missing` are unchanged.
6. **verkstad gets its own `grill`, `spec`, `tickets` and `triage`.**
   - `grill` and `review` are model-invocable: saying "grill me" works without the slash command.
   - `spec`, `tickets` and `triage` stay user-only (`disable-model-invocation: true`), since they publish to GitHub.
7. **A Spec format of verkstad's own:** Problem and outcome, Behaviour, Decisions, Out of scope, Test seams.
   - No user-story list.
   - No glossary section: new terms go into `GLOSSARY.md`.
   - No requirement IDs: `tickets` checks coverage instead.
   - No open questions: a Spec isn't published with one.
8. **Ticket format changes:**
   - Two optional sections: Decisions and Out of scope.
   - Each acceptance criterion is one action and what is then seen.
   - A Ticket may name an existing module or pattern to copy, never a path.
   - No per-Ticket Verification section.
9. **The Agent Brief uses the Ticket's sections**, plus Current behaviour.
10. **The glossary is renamed `CONTEXT.md` → `GLOSSARY.md`.**
    - Everywhere in verkstad, with no fallback to the old name.
    - Re-running `/verkstad:setup` on a Project renames that Project's file with `git mv`.
    - The multi-context variant (`CONTEXT-MAP.md`) is dropped, since no Project uses it.

## Changes, by Ticket

File this report as a Spec and these five Tickets. The current `/verkstad:spec` and `/verkstad:tickets` still work for that, because `mattpocock-skills` stays installed until Ticket 5 lands. Commit this report to `docs/research/` first, so ADR 0009 can cite it.

### Ticket 1: The formats

Blocked by: none.

**New `docs/formats/spec.md`.** In the style of `ticket.md`: what a Spec is, its body, its rules, and how it sits on GitHub. Its body sections:

- **Problem and outcome**: 3–5 lines on who has the problem and what is different when it is solved. This is the why that guides a Ticket writer's judgement calls.
- **Behaviour**: concrete scenarios, written as what someone does and what they then see, including the edge and error cases. The Tickets' acceptance criteria are drawn from these.
- **Decisions**: modules, interfaces, data shapes, protocols and libraries chosen, each with a one-line reason. Stable module or type names are allowed; file paths and line numbers are not.
- **Out of scope**: what this Spec does not do, and what must not change.
- **Test seams**: the public boundaries the tests go through, and how the Verifier will see the work on a Surface.

Its rules:
- No user stories.
- No requirement IDs.
- No glossary section: a new term goes into `GLOSSARY.md`.
- No open questions: an unsettled question is settled with the owner, or recorded in an ADR, before the Spec is published.
- A Spec never carries `ready-for-agent`.
- A Spec is a GitHub issue whose Tickets are its sub-issues (ADR 0006).

**`docs/formats/ticket.md`:**
- Add two optional sections between Acceptance criteria and Blocked by:
  - `## Decisions`: the owner's answers this Ticket depends on, one line each.
  - `## Out of scope`: only when there is nearby work an agent might widen into.
- Reword the Acceptance criteria rule. Each criterion is one action and what is then seen, checkable on its own by the implementer and by the Verifier. Example: "With no Controller connected, pressing Start shows *No Controller* and Start stays locked." A criterion mentions setup (a fixture, a device state) only when it needs something the Project's Verify skill and `docs/agents/project.md` don't already give.
- Add to What to build: it may name an existing module or pattern to copy. File paths stay banned.
- Do not add a Verification section.

**`docs/formats/agent-brief.md`.** The brief's body becomes the Ticket's sections, with Current behaviour first:
- `**Current behaviour:**` (for a bug, what happens and what triage found causes it);
- What to build;
- Acceptance criteria;
- Decisions (optional);
- Out of scope (optional).

Drop Category, Summary and Key interfaces. Keep the AI-generated marker line, the optional context line, the `ready-for-human` variant and the rules (Lasting, What not how, Checkable, Bounded, What triage verified). Make the criteria rule match the Ticket's.

**Glossary rename:**
- `docs/formats/glossary.md`: retitle it as the glossary `GLOSSARY.md`, rename the file throughout, and remove the `CONTEXT-MAP.md` paragraph.
- verkstad's own `CONTEXT.md` → `GLOSSARY.md` (`git mv`), and remove its "Borrowed skill" entry.
- Update every reference outside `docs/adr/` and `docs/research/`. `git grep -c CONTEXT.md` finds them in:
  - `CLAUDE.md`, `README.md`, `docs/contract.md`;
  - `docs/agents/domain.md`, `docs/formats/agent-docs.md`;
  - `prompts/implement-prompt.md`, `prompts/verify-prompt.md`;
  - `skills/create-verify/SKILL.md`, `skills/setup/SKILL.md`.
- `skills/setup/SKILL.md`: when a Project has `CONTEXT.md` and no `GLOSSARY.md`, setup runs `git mv CONTEXT.md GLOSSARY.md` in its commit and says so. A Project that has both is reported to the owner, not merged.

### Ticket 2: The implementer

Blocked by: none.

**`agents/implementer.md`:**
- Remove the `skills:` list (it names only `verkstad:tdd`).
- Keep the existing body line.
- After it, add Appendix A's text verbatim.

**`NOTICE.md`** (new, repo root): one line saying `agents/implementer.md` contains rules copied from Ponytail 5 (github.com/DietrichGebert/ponytail, `9b58c1f`), then Ponytail's MIT licence text, copied from its `LICENSE`. The agent body itself stays free of attribution, since every line of it is sent on every session.

**`prompts/implement-prompt.md`.** In Work, replace "Test-first where there is logic (Skill verkstad:tdd), through the seams the prose doc names." with "Prove new logic with a test, through the seams the prose doc names." In the Fix round paragraph, "Fix what it found, test-first," becomes "Fix what it found,".

**Delete** `skills/tdd/` and `skills/diagnose/`.

**`hooks/sidebar/sidebar.test.ts`** uses `verkstad:tdd` as a sample skill name in a fixture (two places). Change it to `verkstad:review`, so no reference to the deleted skill remains.

### Ticket 3: verkstad's own review

Blocked by: none.

Rewrite `skills/review/SKILL.md` as verkstad's own skill, keeping its name, its description and its fixed-point argument. Steps:

1. Start one subagent with `run_in_background: false`, so its findings come back before the implementer goes on. Give it:
   - the fixed point;
   - the Ticket number;
   - this brief. Read the Ticket (`gh issue view <n> --comments`, the latest comment winning where it differs) and the diff since the fixed point, then report only:
     - each acceptance criterion the diff does not meet;
     - each correctness bug, with how to trigger it;
     - code the change could delete or not add (an unused option, a wrapper, a re-implemented helper or standard-library call).

     Report no style points, no naming opinions and no nice-to-haves. If nothing is found, say so; do not invent findings.
2. When it is back, and before fixing anything, run `verkstad review record` in the worktree, as today.
3. Fix the findings that are real, commit, and run the full Gate. The implementing prompt already says this; the skill doesn't repeat it.

Keep `src/review.ts`, Landing's `review-missing` and every `verkstad:review` reference in `src/` and `test/` as they are.

### Ticket 4: grill, spec, tickets and triage

Blocked by: Ticket 1.

Write each in verkstad's words, short, with no Borrowed line. Where text is adapted from mattpocock/skills (MIT, © 2026 Matt Pocock), add a line and its licence to `NOTICE.md`.

**`skills/grill/SKILL.md`** (new, model-invocable, about 15–25 lines). Its description triggers on the owner asking to be grilled or interviewed about a plan. It:
- maps the decisions as a tree;
- asks, each round, every question whose prerequisites are settled, numbered, each with its recommended answer, worded so "yes" accepts it;
- asks a later question only once the answers it depends on are in;
- looks up facts itself (code, docs, the web, a subagent for a wide search) and never asks the owner for one. Only the decisions are put to the owner;
- writes the questions as plain text, not the AskUserQuestion widget;
- when no question is left, sums up the decisions and acts on nothing until the owner confirms. In a Project, it then suggests `/verkstad:spec`.

**`skills/spec/SKILL.md`** (user-only). It turns the conversation, usually a grilling, into a Spec in `docs/formats/spec.md`'s format. It:
- reads `GLOSSARY.md` and the ADRs in the area first, and uses their terms;
- stops and asks the owner when it finds an open question;
- proposes new or sharper glossary terms, and writes them to `GLOSSARY.md` on the owner's yes, in a commit ending `Refs #<spec>` once the Spec has a number;
- shows the owner the Spec and publishes it, without `ready-for-agent`, only on their yes. It names the issue as `<owner>/<repo>#<n>`;
- reads the issue tracker and labels from `docs/agents/issue-tracker.md` and `docs/agents/triage-labels.md`.

**`skills/tickets/SKILL.md`** (user-only). It splits a Spec (`#<n>`, or the conversation) into Tickets in `docs/formats/ticket.md`'s format. It keeps the rules the Borrowed wrapper and the Ticket format already have:
- vertical slices sized for one implementer session;
- a thin first Ticket that fixes the shape, with the widening Tickets blocked by it;
- a wide mechanical refactor as expand, migrate in batches, then contract;
- no design decision left open: ask the owner and write the answer under Decisions;
- no file paths.

Before showing the breakdown, it checks that every Behaviour item in the Spec is covered by some Ticket's acceptance criteria, and lists any that aren't. It then shows the owner a numbered breakdown (title, blocked by, what it delivers) and publishes only once the owner approves:
- blockers first;
- each Ticket a sub-issue of the Spec, with native `blocked_by` links;
- labelled `ready-for-agent`.

**`skills/triage/SKILL.md`** (user-only). It moves issues through the five labels in `docs/agents/triage-labels.md`. It keeps every verkstad rule the Borrowed wrapper has:
- the owner is the reporter;
- `needs-info` questions come from the latest triage notes or a Park's comment, asked a round at a time;
- an open design decision or a too-big issue never becomes `ready-for-agent`; it is decided or split first;
- a `ready-for-human` issue is decided with the owner;
- nothing is posted and no label is changed without the owner's yes;
- a Parked Ticket keeps its branch.

A `ready-for-agent` issue gets an Agent Brief in the new format. A bug is reproduced where it can be, and the brief says whether it was. Matt's out-of-scope records (`.out-of-scope/`) are not carried over.

Keep `hooks/sidebar/register.tsx`'s `/verkstad:triage` command as it is.

### Ticket 5: Retire the borrowing

Blocked by: Tickets 2, 3 and 4.

- **Delete** `scripts/check-borrowed.sh`, and the `borrowed` step in `.claude/harness.json`.
- **ADR 0009, "verkstad's skills are its own".** Every skill verkstad uses is its own. The Ponytail rules live in the implementer's system prompt. Formats change only through an ADR (as ADR 0003 says). It supersedes ADR 0002 and cites this report. Add a line to ADR 0002 saying it is replaced by ADR 0009, as ADR 0007 does for its serial consequence.
- **`CLAUDE.md`:**
  - drop the two Borrowed-skill bullets and the `check-borrowed.sh` mention under `scripts/`;
  - keep the rule that a skill, agent or prompt calls another skill by its verkstad name;
  - rename the "Domain docs" line to `GLOSSARY.md`.
- **`docs/agents/triage-labels.md` and the matching block in `docs/formats/agent-docs.md`:** drop the "Label in mattpocock/skills" column, leaving each label and its meaning. `skills/setup/SKILL.md` writes that block, so a re-run writes the new shape.
- **`README.md`:**
  - point to `GLOSSARY.md`;
  - add one line listing the skills an owner types: `/verkstad:grill`, `/verkstad:spec`, `/verkstad:tickets`, `/verkstad:triage`, `/verkstad:start-run`, `/verkstad:reflect` and `/verkstad:setup`.
- **For the owner, after this lands:** uninstall the `mattpocock-skills` plugin and the Ponytail plugin (`claude plugin list` shows their exact names). Re-run `/verkstad:setup` in Ray and in cnc-control to rename their glossaries.

## Done when

- Outside `docs/adr/` and `docs/research/`, `git grep -n -i -E "mattpocock|matt-pocock|borrowed|CONTEXT\.md|verkstad:(tdd|diagnose)"` prints nothing.
- `skills/` holds `grill`, `spec`, `tickets`, `triage` and `review` as verkstad's own skills, and no `tdd` or `diagnose`.
- The Gate passes: typecheck, test, plugin validate and sidebar.
- With `mattpocock-skills` uninstalled, one real Ticket in cnc-control:
  - runs through `verkstad run --ticket <n>` and lands;
  - its implementer transcript shows Appendix A in the system prompt and one review subagent.
- In a scratch conversation, "grill me on <a small plan>" starts `verkstad:grill` without the slash command, and asks in numbered rounds with recommended answers.
- After `/verkstad:setup` re-runs, Ray and cnc-control each have a `GLOSSARY.md` and no `CONTEXT.md`.

## Out of scope

- `verkstad run`, Landing, the Verifier, the Gate, the sidebar and `reflect`. The next report audits the loop for simplification.
- The experiment of dropping the implementer's own Walk.
- Ponytail's other skills (review, audit, debt, gain, help) and its levels.
- Rewriting existing Specs, Tickets or Agent Briefs in Ray or cnc-control into the new formats. New ones use them; old ones stay as they are.

## To check while implementing

- That `--append-system-prompt` still carries the agent body in the headless flags verkstad passes, after the `skills:` list is removed. Check one session's transcript.
- Whether `claude plugin validate` objects to a skill directory being removed while an installed copy of the plugin still lists it. If it does, bump the plugin's version.

## Sources

- [mattpocock/skills](https://github.com/mattpocock/skills) at `49dd158` (2026-10-09): `grilling`, `tdd`, `to-spec`, `to-tickets`, `SCOPE.md`
- [Matt Pocock, implement-spec docs](https://www.aihero.dev/skills-implement-spec) (updated 2026-10-05)
- [Pragmatic Engineer: AI skills with Matt Pocock](https://newsletter.pragmaticengineer.com/p/ai-skills-with-matt-pocock) (2026-09-17)
- [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) at `9b58c1f`: `skills/ponytail/SKILL.md`, `hooks/claude-codex-hooks.json`, `benchmarks/results/2026-10-07-agentic.md`
- [Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)
- [Prompting Claude Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5)
- [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- [Claude Code skills](https://code.claude.com/docs/en/skills)
- [Anthropic: Harness design for long-running apps](https://www.anthropic.com/engineering/harness-design-long-running-apps) (2026-03-24)
- [Anthropic: Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) (2025-11-26)
- [Spec ablation study, alphaxiv 2608.25399](https://www.alphaxiv.org/abs/2608.25399) (2026-08)
- [Copilot PR study, arXiv 2512.21426](https://arxiv.org/html/2512.21426v1) (2025-12)
- [Böckeler: Understanding spec-driven development tools](https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html) (2025-10-15)
- [Thoughtworks Radar: spec-driven development](https://www.thoughtworks.com/radar/techniques/spec-driven-development)
- [Kiro specs](https://kiro.dev/docs/specs/concepts/)
- [GitHub Spec Kit spec template](https://github.com/github/spec-kit/blob/main/templates/spec-template.md)
- [Devin: instructing Devin effectively](https://docs.devin.ai/essential-guidelines/instructing-devin-effectively)
- [GitHub Copilot: get the best results](https://docs.github.com/en/copilot/tutorials/cloud-agent/get-the-best-results)

## Appendix A: the implementer's rules

Copy this text, unchanged, into `agents/implementer.md` after its existing body line. It is Ponytail 5's `skills/ponytail/SKILL.md` at `9b58c1f`, without its frontmatter, title, activation line and levels.

```md
You are a lazy senior developer. The best code is the code never written. You solve the whole problem with the least new code. End your reply with one or two lines: what you skipped or did not check, and any risk the user must know.

## Before you write

Read the task and the code it touches. List every place your change must reach: callers, tests, fixtures, config, exports. Check what your change could break for users: data it would destroy or expose, callers that stop working. That is scope. Extra features are not.

## The smallest complete change

Take the first option that fully works:

1. Does it need to exist? Skip features, options and flexibility nobody asked for, and name them in one line. A vague request ("build me X") gets the smallest version that does the core job.
2. Already in this codebase (a helper, component, service, pattern)? Use it the way the surrounding code does.
3. Standard library or a platform feature? Use it, unless the project has its own. A house component beats a native widget.
4. An installed dependency? Use it. Never add a dependency for a few lines.
5. Can it be one line a reader gets at a glance? One line.
6. Otherwise: the minimum code that works.

- Be lazy about the solution, never about the change itself: finish every part the task needs, including the callers, tests and fixtures your change breaks.
- No abstraction, wrapper, type conversion, option, config, boilerplate or "for later" code nobody asked for. Keep values in the form the platform already gives you. Deletion beats addition. Keep the structure the codebase already has: its layers, interfaces and conventions.
- The shortest working diff wins, once you know everything it must touch. A one-liner that needs decoding is not short.
- Comment only the why the code cannot show, in one line.
- Bug fix: before you edit, grep every caller of the function you touch, then fix the root cause once in the shared code.
- Code you move or merge keeps its error handling and validation.
- Between options of equal size, take the one that is correct on edge cases.
- Lazy code without its check is unfinished: new non-trivial logic (a branch, a loop, a parser, money or security, or a whole new script or app) leaves one small test or an assert-based self-check. Trivial changes need none.
- A shortcut with a known limit gets a code comment in this form: `shortcut: <the limit>, <when to upgrade>`.

Never cut: validation at trust boundaries, error handling that prevents data loss, security, accessibility, the calibration real hardware needs, anything the user asked for.
```
