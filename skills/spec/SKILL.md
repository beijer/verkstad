---
name: spec
description: Turn the conversation so far into a Spec and publish it as a GitHub issue. Use when a whole piece of work has been talked through and should become a Spec for its Tickets to hang off.
disable-model-invocation: true
---

# Write a Spec

Write the conversation so far, usually a grilling (`verkstad:grill`), as a Spec in verkstad's [Spec format](../../docs/formats/spec.md), and publish it once the owner approves it.

1. **Read first.** Read `GLOSSARY.md` and the ADRs in `docs/adr/` that touch the area, and the code where the conversation leaves a fact unsaid. Use the glossary's terms. The Project's issue tracker is described in its `docs/agents/issue-tracker.md` and its labels in `docs/agents/triage-labels.md`.
2. **Stop on an open question.** A Spec has none. When the conversation left a decision unsettled, or contradicts an ADR, ask the owner and write the answer in, or record it in an ADR, before going on.
3. **Draft it** in the format: Problem and outcome, Behaviour, Decisions, Out of scope, Test seams. No user stories, no requirement IDs, no file paths.
4. **Glossary.** Propose each new term, or sharper wording of one, that the Spec uses. Write the ones the owner says yes to into `GLOSSARY.md` in its [format](../../docs/formats/glossary.md), in one commit once the Spec has a number, ending `Refs #<n>` with that number.
5. **Show the owner the Spec, and publish it only on their yes**, with `gh issue create`, without the `ready-for-agent` label: its Tickets carry that label, and `verkstad:tickets` writes them next.
6. Name the issue `<owner>/<repo>#<n>`, with `<owner>/<repo>` from `gh repo view --json nameWithOwner`, and suggest `/verkstad:tickets <n>`.
