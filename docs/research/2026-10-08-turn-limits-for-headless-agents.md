# Bound a Ticket by dollars the model can see, not by turns it cannot

*Researched 2026-10-08 against Claude Code 2.1.286, Opus 5.5 and Sonnet 5.5.*

A hard turn limit is still worth keeping, but only as a runaway fuse set well above normal work. It is a poor way to bound a Ticket, for three reasons. The model never sees a turn count, so it cannot wrap up before the limit. The session dies between a tool result and the next model call, so it leaves no report. And a turn is a unit of work only loosely: within one Tier, the cost of a turn varies about 3–4x. Claude Code has a better primary bound for headless runs: `--max-budget-usd`. As of 2.1.286 it puts a running `USD budget: $used/$total; $left remaining` reminder into the model's context on every turn. In a small test on 2026-10-08, Opus 5.5 used that reminder to stop and report before the cap, even without being told to. That reminder is not documented, so treat it as current behaviour rather than a contract. The API's purpose-built feature for this, task budgets, is not available in Claude Code. A session that stops anyway should be handled by the harness, not by the model's goodwill. Require the report as `--json-schema` structured output. On any `error_max_*` result, resume the session once with a short wrap-up prompt and a small fresh budget. If that also fails, classify the Ticket from git state.

## How each mechanism ends a session

| Mechanism | Scope | Does the model see it coming? | How the session ends |
| --- | --- | --- | --- |
| `--max-turns N` (`claude -p`) / `maxTurns` (SDK) | Tool-use turns of the main loop only; a subagent call is one turn | **No.** A test run had no counter, warning or reminder in the transcript | Exits 1 with `subtype: "error_max_turns"`, `terminal_reason: "max_turns"`. No `result`, no structured output. `Stop` and `StopFailure` hooks do not fire; only `SessionEnd` (`reason: "other"`) |
| `maxTurns` in agent frontmatter | That subagent's own turns | **No** | Since v2.1.246 (2025-08-25) the parent gets "NOTE: this agent stopped at its N-turn limit before finishing. It was still calling tools and had produced no report", plus a hint to continue it with `SendMessage` |
| `--max-budget-usd X` (`claude -p`) / `maxBudgetUsd` (SDK) | Client-side cost estimate, **subagents included**; on resume, only the new spend counts | **Yes, undocumented.** A `<system-reminder>USD budget: $0.0117/$0.02; $0.0082 remaining</system-reminder>` arrives each turn | `subtype: "error_max_budget_usd"`, `terminal_reason: "budget_exhausted"`, no `result`. Overshoots by up to one response. Since v2.1.217 also refuses new subagents and stops background ones |
| Task budgets (`output_config.task_budget`, API beta `task-budgets-2026-03-13`) | Tokens across one agentic loop; supported on Opus 5.5 and Sonnet 5.5 | **Yes, by design:** a server-side countdown the model paces against | Advisory, never enforced. **"Not supported on Claude Code"** |
| API context awareness (`<budget:token_budget>`, `Token usage: …remaining`) | Context window | Only on Sonnet 5 / 4.6 / 4.5 and Haiku 4.5; **not on Opus 4.7+ or Sonnet 5.5** | Not a stop; it informs the model |
| Effort (`effort:` in frontmatter, `--effort`) | Depth per step | Not a limit | Never ends a session, but lower effort means "fewer and terser tool calls", so it moves the turn count |
| Auto-compaction | Context window | Summarises in place | Never ends a session. 1M-context models compact at about 967k by default; adjust with `--autocompact` or `CLAUDE_CODE_AUTO_COMPACT_WINDOW` |
| Wall-clock | None built in for `-p` | No | Only an outer `timeout(1)`. A session blocked on a hung command burns neither turns nor dollars |
| `Stop` hook, `/goal` | Normal end of turn | The model gets the block reason | Blocks a *voluntary* stop (at most 8 consecutive continuations, `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`). Never fires at a turn or budget limit, so it cannot force a final report there |
| `--json-schema` | Final answer | Yes, as an output contract | Validated JSON in `structured_output` on `success`. Nothing on any `error_max_*` subtype |

Sources: [CLI reference](https://code.claude.com/docs/en/cli-reference), [How the agent loop works](https://code.claude.com/docs/en/agent-sdk/agent-loop), [Subagents](https://code.claude.com/docs/en/sub-agents), [SDK subagent caps](https://code.claude.com/docs/en/agent-sdk/subagents), [Hooks](https://code.claude.com/docs/en/hooks), [/goal](https://code.claude.com/docs/en/goal), [Model config](https://code.claude.com/docs/en/model-config), [Task budgets](https://platform.claude.com/docs/en/build-with-claude/task-budgets), [Context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows), [Effort](https://platform.claude.com/docs/en/build-with-claude/effort), and the [changelog](https://code.claude.com/docs/en/changelog) (v2.1.217, 2026-07-21; v2.1.246, 2026-08-25). All docs pages were read on 2026-10-08.

The behaviours marked "test" and "undocumented" come from runs on 2026-10-08 with Claude Code 2.1.286 in a scratch directory:

- **`--max-turns 2` (Haiku).** `Stop` and `StopFailure` did not fire. `SessionEnd` did. The model saw nothing about turns.
- **`--max-budget-usd 0.02` (Haiku).** One `budget_usd` attachment, rendered as the reminder above, arrived per turn. The session ended at $0.0228.
- **`maxTurns: 2` subagent.** The parent received the "stopped at its 2-turn limit" note quoted above.
- **Two Opus 5.5 runs with `--max-budget-usd 1.00`.** The task was "read and summarise all 23 files in `src/`", which cannot be done for $1. Neither run hit the cap. The control was told nothing about the budget. It stopped at $0.90, saying the "$1 budget was nearly used up", and named the 9 files it skipped. The treatment was told to report once under 30% remained. It stopped at $0.74 with the same kind of report. Both ended `success`.

So the reminder works on Opus 5.5 at least in this toy case. A practitioner test from 2026-09-07 described the budget as CLI-side only, with the model unaware of it ([mer.vin](https://mer.vin/news/what-max-budget-usd-actually-kills-mid-agent-loop/)). Either the reminder is newer than that test, or the test did not look for it.

## What Anthropic recommends

- **Budgets over turn caps for production.** The Agent SDK docs say "Setting a budget is a good default for production agents". Their example uses `max_turns=30` with the comment "Prevent runaway sessions", and on `error_max_turns` it says "Resume with a higher limit" ([agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)). The Opus 5 prompting guide names `max_budget_usd`, not a turn cap, as the deterministic spend cap for Claude Code and the SDK ([Prompting Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)). The December 2024 guidance that "it's also common to include stopping conditions (such as a maximum number of iterations)" still stands as a control measure ([Building effective agents](https://www.anthropic.com/engineering/building-effective-agents), 2024-12-19).
- **Give the model a visible budget so it can finish gracefully.** Task budgets exist so that the model can "finish gracefully (summarize findings, report progress) as it approaches the budget rather than cutting off mid-action". Size them at "the p99 of your per-task token spend". A budget "clearly insufficient" for the task causes "refusal-like behavior": the model scopes down or stops early ([Task budgets](https://platform.claude.com/docs/en/build-with-claude/task-budgets)). The Opus 5.5 guide gives the same advice for wall-clock time: show `elapsed 340s / 1200s`, and since "the budget is advisory and nothing stops the model at the limit… keep your own timeout" ([Prompting Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5)).
- **Do not make the model anxious about context.** The general guide says to tell the model that compaction lets it continue, and "do not stop tasks early due to token budget concerns". It also says to make sure it does not "run out of context with significant uncommitted work", and to "use git for state tracking" ([Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)). Premature wrap-up ("context anxiety") was a Sonnet 4.5 trait that Anthropic's March 2026 harness had to design around ([Harness design](https://www.anthropic.com/engineering/harness-design-long-running-apps), 2026-03-24).
- **Opus 5.5's own failure is stopping too early, not running too long.** In unattended loops it sometimes ends a turn with a progress report. Anthropic says to "treat a text-only end of turn as a report rather than as proof the task is done", to continue it with a message naming the open items, and to "stop after two or three automatic continuations" ([Prompting Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5)). A `Stop` hook or `/goal` is the documented way to let "an unattended run finish correctly without you" ([Best practices](https://code.claude.com/docs/en/best-practices)).
- **Effort is the main cost lever on Opus 5.5.** Its default is `medium`, which matched or beat Opus 5 at `high` "in fewer steps and with fewer tokens" ([Prompting Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5)). The hard Tier runs at `high`, which by the effort docs means more tool calls, and so more turns, per Ticket.

No Anthropic source found says "never use turn caps". The position is: caps are a guard, a budget is the default bound, and the model should be told what it has.

## A turn is a poor unit of work

From 144 Tier-agent transcripts in cnc-control, ray and verkstad (`~/.claude/projects/*/subagents/`; costs priced at list Opus 5.5 / Sonnet 5.5 rates from recorded usage, so they are estimates):

| Tier | n | Turns, median / max | Cost per agent, median / max | Cost per turn, min–max |
| --- | --- | --- | --- | --- |
| light (Sonnet, medium) | 48 | 17 / 80 | $0.28 / $1.83 | $0.012–0.050 |
| standard (Opus, medium) | 49 | 65 / 124 | $2.71 / $13.03 | $0.022–0.105 |
| hard (Opus, high) | 47 | 138 / 205 | $7.37 / $16.64 | $0.027–0.083 |

- **Turns and cost track each other across Tiers** (Pearson r ≈ 0.96, cost proxy against turns), because every turn re-reads a growing context. A turn cap is therefore a crude cost cap, not a meaningless one. Within one band the cost is still loose: hard agents with 100–140 turns cost $3.92–$8.43, a 2x spread.
- **What a turn costs depends on what the turn does.** One `Explore` call is one turn for the caller, while the subagent's own turns and tokens are uncounted by the caller's `maxTurns`. A rejected command (the worktree guard and hook refusals the Tier agents warn about) is a full turn that does no work. Effort changes how many calls the same work takes.
- **The hard Tier hits its own cap as a matter of course.** 6 of 47 hard runs ended at 201–205 turns, and their peak contexts reached 331k–388k tokens against the agents' "150k" guideline. Each one then cost a nudge, and often a fresh-agent Resume that re-explored from scratch.

## Recommendation for verkstad

**1. In a `claude -p` per Ticket (the `verkstad run` direction): make the dollar budget the bound.**

- **Budget per Tier.** Pass `--max-budget-usd` per Tier. Start at about twice the observed maximum and recalibrate from `total_cost_usd` after 20 or so Tickets per Tier: **light $5, standard $25, hard $35**. A budget near the median would trigger the scope-down behaviour Anthropic warns about.
- **Tell the model its budget, in the implement prompt.** For example: "This session has a USD budget, and system reminders show what is left. Do not stop early to save budget. When about 15% remains, start no new work: commit what passes, leave the worktree clean, and report `partial`, saying exactly what is left." Remove "You stop at N turns" from `agents/ticket-*.md`: the model cannot see a turn count, so the sentence gives it nothing to act on.
- **Commit as you go.** Add "commit each time `verkstad gate --quick` passes" to the Tier agents' phases. An abrupt stop then costs only the uncommitted step, which is what Anthropic's "significant uncommitted work" line is about.
- **Keep `--max-turns` only as a fuse.** Set it at about twice the observed maximum, so that it fires only on pathology such as a cheap refusal loop at low context: **light 200, standard 250, hard 400**. Wrap the process in `timeout` (for example 3h for hard) for hangs, which neither a turn cap nor a budget catches.
- **Make the report the session's output.** Pass the report fields as `--json-schema`, and route only on `structured_output` from a `success` result. Add a `Stop` hook (a `verkstad hook stop`) that blocks a voluntary end while the worktree is dirty or the branch has no commits. That covers Opus 5.5's early-stop habit and stays within the 8-continuation cap.

**2. In the current orchestrator-with-subagents design** (until `verkstad run` exists) no per-subagent budget is available: `--max-budget-usd` covers the whole orchestrator session, and frontmatter has no budget field. `maxTurns` stays the only bound.

- Raise hard to **about 300**, since 13% of hard runs hit 200.
- Add the commit-as-you-go line.
- When a subagent stops at its limit, continue *that* agent with `SendMessage`, as the platform's own hand-back suggests. This keeps its context, where a fresh Resume pays for re-exploration. The message stays "do no new work, commit, report".
- Consider an A/B of the hard Tier at `effort: medium` against `high`. On Opus 5.5 that is the documented way to get the same work in fewer steps.

**3. A session that stops without a report** (`error_max_turns`, `error_max_budget_usd`, `timeout` exit, or `success` without valid `structured_output`) gets exactly one wrap-up, run by code:

```
claude -p --resume <session_id> --max-turns 15 --max-budget-usd 3 --json-schema <report schema> \
  "Your session hit its limit. Do no new work. Commit what passes as it stands, leave the worktree clean, and give the report; status partial unless every criterion is met."
```

A resumed session's earlier spend does not count against the new cap ([cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking)), so the wrap-up gets its own budget. If the wrap-up also returns no structured output, do not ask a model again. Classify from git: commits ahead of `origin/<base>` mean `partial` with the commit log as the report, and a dirty tree means Park with `git status`. This replaces the prose rule in `skills/orchestrate/SKILL.md` step 5, "No report, turn limit reached… A second stop without a report is partial", with a tested branch in TypeScript.

## Where the evidence is thin

- **The budget reminder is undocumented.** Neither the CLI reference, the cost docs nor the changelog mention it. It is visible only in transcripts (`attachment.type: "budget_usd"`) from 2.1.286. It could change or disappear without notice. A test in verkstad's suite (a `claude -p` run with a tiny budget, asserting the attachment appears) would at least catch that.
- **Whether models wrap up on the reminder rests on n = 1 per arm,** on a toy reading task, on Opus 5.5 only. Sonnet 5.5 (the light Tier) was not tested. Its guide warns that harness countdowns after tool results can make it misread genuine user messages as injections ([Prompting Sonnet 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5)). That matters less in headless runs, where no user types mid-turn, but it is untested.
- **Sizing the budget for real Tickets** (scope-down if too tight, waste if too loose) is unmeasured. The suggested dollar figures are extrapolated from capped runs, whose true need was higher.
- **The transcript costs are estimates.** They are priced from recorded `usage` at list rates. Recorded output tokens may undercount thinking, and nested `Explore` costs are excluded. On a subscription the cap compares an API-price equivalent, not a charge. One user reported it stopping a Max-plan run while the reported cost was $0 ([aident.ai](https://aident.ai/blog/fix-claude-code-max-budget-usd-subscription), 2026-08-09). Here the estimate worked, at $0.74–$0.90.
- **Subagent continuation.** Whether a subagent continued with `SendMessage` gets a fresh `maxTurns` allowance is implied by the hand-back hint but not documented.
- **A second token countdown.** Claude Code also injects an undocumented `<total_tokens>N tokens left</total_tokens>` reminder (about 15M at the start, 167 times in one hard-Tier transcript). Its source and whether it can be configured are unknown, and it is far too large to bound a Ticket.
- **No Anthropic source compares turn caps with budgets on outcome quality.** The recommendation rests on the documented mechanics, the stated guidance, and verkstad's own logs.
