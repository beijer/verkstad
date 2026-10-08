// verkstad's only way to Claude Code: one headless session, `claude -p`, run in
// a worktree with the prompt on its stdin, a JSON schema for its report and no
// one to answer a permission prompt. It asks for the result as JSON and parses
// it here. A session resumed with `resume` continues that session's context,
// in the same working directory, under the same session id.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Failure } from "./fail.ts";

/** How a session runs: an agent's model, effort and turn limit, its system prompt, and the tools it may not use. */
export interface Agent {
  name: string;
  model: string;
  effort: string;
  maxTurns: number;
  /** The agent file's body, appended to Claude Code's system prompt. */
  body: string;
  disallowedTools: string[];
}

export interface SessionOptions {
  cwd: string;
  prompt: string;
  agent: Agent;
  schema: object;
  /** The session to continue, instead of starting a new one. */
  resume?: string;
  /** A turn limit other than the agent's. */
  maxTurns?: number;
  /** The most the session may spend, in USD. */
  budgetUsd?: number;
  /** Directories beyond `cwd` the session may write to without asking, such as the log directory. */
  addDirs?: string[];
  /** How long the session may run, in milliseconds, before it is killed as hung. */
  timeoutMs?: number;
}

export interface SessionResult {
  sessionId: string;
  /** `success`, or why the session ended without finishing, e.g. `error_max_turns`. */
  subtype: string;
  /** The structured output, or null when the session gave none. */
  report: Record<string, unknown> | null;
  costUsd: number;
  turns: number;
}

/**
 * Whether a session ended by reaching a limit verkstad set (its turn fuse, its budget, its time), rather than
 * by failing; `error_timeout` is verkstad's own subtype for a session it killed.
 */
export function stoppedAtLimit(result: SessionResult): boolean {
  return ["error_max_turns", "error_max_budget_usd", "error_timeout"].includes(result.subtype);
}

export function session(options: SessionOptions): SessionResult {
  const { agent } = options;
  const args = [
    "-p",
    "--output-format",
    "json",
    "--model",
    agent.model,
    "--effort",
    agent.effort,
    "--max-turns",
    String(options.maxTurns ?? agent.maxTurns),
    "--append-system-prompt",
    agent.body,
    "--json-schema",
    JSON.stringify(options.schema),
    "--permission-mode",
    "auto",
    "--permission-prompts",
    "none",
  ];
  if (agent.disallowedTools.length) args.push("--disallowedTools", agent.disallowedTools.join(","));
  if (options.budgetUsd !== undefined) args.push("--max-budget-usd", String(options.budgetUsd));
  for (const dir of options.addDirs ?? []) args.push("--add-dir", dir);
  const id = options.resume ?? randomUUID();
  args.push(options.resume ? "--resume" : "--session-id", id);

  // VERKSTAD_RUN tells the plugin's hook the session is a Run's, outside Claude Code's worktree isolation.
  const r = spawnSync("claude", args, {
    cwd: options.cwd,
    input: options.prompt,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, VERKSTAD_RUN: "1" },
    timeout: options.timeoutMs,
  });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    return { sessionId: id, subtype: "error_timeout", report: null, costUsd: 0, turns: 0 };
  }
  if (r.error) throw new Failure(`could not run claude: ${r.error.message}`);
  let reply: Record<string, unknown>;
  try {
    reply = JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    const said = (r.stderr.trim() || r.stdout.trim()).slice(0, 500);
    throw new Failure(`claude printed no result (exit ${r.status}): ${said}`);
  }
  const report = reply.structured_output;
  return {
    sessionId: typeof reply.session_id === "string" ? reply.session_id : id,
    subtype: typeof reply.subtype === "string" ? reply.subtype : "unknown",
    report: typeof report === "object" && report !== null && !Array.isArray(report) ? (report as Record<string, unknown>) : null,
    costUsd: typeof reply.total_cost_usd === "number" ? reply.total_cost_usd : 0,
    turns: typeof reply.num_turns === "number" ? reply.num_turns : 0,
  };
}
