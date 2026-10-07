// `verkstad hook subagent-stop`: the plugin's SubagentStop hook (hooks/hooks.json). Claude Code
// sends it the event as JSON on stdin when an agent is about to stop; it prints a decision as JSON
// on stdout, or nothing to let the agent stop.
//
// It blocks the stop of a Tier agent (`ticket-light`, `ticket-standard`, `ticket-hard`) in an
// agent worktree on `issue-<n>` with commits ahead of `origin/<base>` and no review of the branch
// recorded (src/review.ts): Landing would refuse that branch with review-missing, and the agent
// still has the context to run verkstad:review in a minute. Its reason names verkstad:review and
// `verkstad review record`. Any other agent, such as the Verifier or a search the Tier agent
// started, stops as it would, and so does one whose stop this hook already blocked once
// (`stop_hook_active`), so that it cannot loop. Outside a Project, it lets the agent stop.

import { existsSync } from "node:fs";
import { readBaseBranch } from "./contract.ts";
import { Failure } from "./fail.ts";
import { inLinkedWorktree, logDirectory, tryGit, worktreeRoot } from "./git.ts";
import { missingReview } from "./review.ts";

export interface StopEvent {
  cwd?: unknown;
  agent_type?: unknown;
  stop_hook_active?: unknown;
}

/** A Tier agent's type, named with or without its plugin. */
const TIER = /^(?:[^:]+:)?ticket-(?:light|standard|hard)$/;

function reason(branch: string, base: string): string {
  return (
    `verkstad: ${branch} has commits ahead of origin/${base} and no review of it is recorded, so Landing would refuse it ` +
    `with review-missing. Before you hand back, run \`git merge-base HEAD origin/${base}\` on its own and review the branch ` +
    "with Skill verkstad:review against the commit it prints; when both reviews are back, run `verkstad review record` " +
    "in this worktree. Then fix the real findings, run the Gate again and hand back."
  );
}

export function subagentStop(event: StopEvent): void {
  if (event.stop_hook_active === true) return;
  if (typeof event.agent_type !== "string" || !TIER.test(event.agent_type)) return;
  const cwd = typeof event.cwd === "string" ? event.cwd : process.cwd();
  if (!existsSync(cwd) || !inLinkedWorktree(cwd)) return;
  const root = worktreeRoot(cwd);
  const branch = tryGit(root, ["branch", "--show-current"]).stdout.trim();
  if (!/^issue-[0-9]+$/.test(branch)) return;
  let base: string;
  try {
    base = readBaseBranch(root);
  } catch (error) {
    if (error instanceof Failure) return;
    throw error;
  }
  const ahead = tryGit(root, ["rev-list", "--count", `origin/${base}..HEAD`]);
  if (ahead.status !== 0 || Number(ahead.stdout.trim()) === 0) return;
  if (missingReview(logDirectory(root), branch) === null) return;
  process.stdout.write(JSON.stringify({ decision: "block", reason: reason(branch, base) }) + "\n");
}
