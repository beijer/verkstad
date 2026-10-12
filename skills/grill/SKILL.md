---
name: grill
description: Grill the owner about a plan, decision or idea in numbered rounds of questions, each with a recommended answer, until every decision is settled. Use when the owner asks to be grilled or interviewed about a plan, or to stress-test it.
---

# Grill

Interview the owner until the two of you share one understanding of the plan.

- **Map the decisions as a tree.** Each decision branches into the ones that hang off it. A question is ready once every decision it depends on is settled.
- **Ask in rounds.** Each round asks every ready question, and only those: one whose answer depends on another open question waits for a later round. Number each question and give your recommended answer, worded so that "yes" accepts it. Then wait for the answers, and redraw the tree from them before the next round.
- **Look up facts yourself.** Read the code and the docs, search the web, send a subagent on a wide search; never ask the owner for a fact you can find. Only the decisions go to the owner. A question that waits on a lookup waits for its round; ask the rest now.
- **Plain text.** Write the questions in your reply, not with the AskUserQuestion tool.

A round looks like this:

```
1. <the question, with the choices when there are some>
   Recommended: <the answer you would pick, and why in one line>

2. …
```

When no question is left, sum up the decisions, one line each, and act on nothing until the owner confirms them. In a Project, then suggest `/verkstad:spec` to write them up as a Spec.
