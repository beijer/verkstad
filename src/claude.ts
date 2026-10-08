// verkstad's only way to Claude Code: one headless session, `claude -p`, run in
// a worktree with the prompt on its stdin, a JSON schema for its report and no
// one to answer a permission prompt. It asks for the result as JSON and parses
// it here. A session resumed with `resume` continues that session's context,
// in the same working directory, under the same session id. A session that
// runs out of time, or whose `signal` fires, is killed with every process it
// started.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { Failure } from "./fail.ts";

/** How a session runs: an agent's model and effort, its system prompt, and the tools it may not use. */
export interface Agent {
  name: string;
  model: string;
  effort: string;
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
  /** The most turns the session may take. */
  maxTurns: number;
  /** The most the session may spend, in USD. */
  budgetUsd?: number;
  /** Directories beyond `cwd` the session may write to without asking, such as the log directory. */
  addDirs?: string[];
  /** How long the session may run, in milliseconds, before it is killed as hung. */
  timeoutMs?: number;
  /** Kills the session, and every process it started, when it fires. */
  signal?: AbortSignal;
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
 * by failing; `error_timeout` is verkstad's own subtype for a session it killed as hung. `error_aborted`, its
 * subtype for a session killed by its `signal`, is neither.
 */
export function stoppedAtLimit(result: SessionResult): boolean {
  return ["error_max_turns", "error_max_budget_usd", "error_timeout"].includes(result.subtype);
}

/** Every process descended from `pid`, read from /proc: the session's children, theirs, and so on. */
function descendants(pid: number): number[] {
  const children = new Map<number, number[]>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${name}/stat`, "utf8");
    } catch {
      continue; // It ended while we looked.
    }
    // The fields after the command's name, which may hold spaces and parentheses: state, then the parent.
    const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    children.set(parent, [...(children.get(parent) ?? []), Number(name)]);
  }
  const found: number[] = [];
  for (let queue = [pid]; queue.length; ) {
    const next = children.get(queue.shift()!) ?? [];
    found.push(...next);
    queue.push(...next);
  }
  return found;
}

/**
 * Kills the session `pid`, the leader of its own process group, with every process it started: its group, which
 * holds what was orphaned since, and its descendants, found before any is killed, which holds what left the group.
 */
function killTree(pid: number): void {
  const tree = descendants(pid);
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group has ended already.
  }
  for (const p of [pid, ...tree]) {
    try {
      process.kill(p, "SIGKILL");
    } catch {
      // It has ended already.
    }
  }
}

export async function session(options: SessionOptions): Promise<SessionResult> {
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
    String(options.maxTurns),
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

  const r = await new Promise<{ stdout: string; stderr: string; status: number | null; ended: "timeout" | "aborted" | null }>(
    (done, failed) => {
      // In a process group of its own, so that killing it kills what it started; the owner's Ctrl-C, which no
      // longer reaches it, is passed on.
      const child = spawn("claude", args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], detached: true });
      let stdout = "";
      let stderr = "";
      let ended: "timeout" | "aborted" | null = null;
      const kill = (why: "timeout" | "aborted") => {
        ended ??= why;
        if (child.pid !== undefined) killTree(child.pid);
      };
      const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => kill("timeout"), options.timeoutMs);
      const onAbort = () => kill("aborted");
      const passOn = (signal: NodeJS.Signals) => {
        if (child.pid !== undefined) killTree(child.pid);
        process.kill(process.pid, signal);
      };
      const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
      for (const signal of signals) process.once(signal, passOn);
      const settle = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        for (const signal of signals) process.removeListener(signal, passOn);
      };
      if (options.signal?.aborted) onAbort();
      options.signal?.addEventListener("abort", onAbort);
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      // A session killed before it read its prompt closes its stdin under us.
      child.stdin.on("error", () => {});
      child.stdin.end(options.prompt);
      child.on("error", (error) => {
        settle();
        failed(new Failure(`could not run claude: ${error.message}`));
      });
      // A killed session's output is not read, so a process that escaped the kill holding its stdout cannot hang the Run.
      child.on("exit", (status) => {
        if (ended) settle();
        if (ended) done({ stdout, stderr, status, ended });
      });
      child.on("close", (status) => {
        settle();
        done({ stdout, stderr, status, ended });
      });
    },
  );
  if (r.ended === "timeout") return { sessionId: id, subtype: "error_timeout", report: null, costUsd: 0, turns: 0 };
  if (r.ended === "aborted") return { sessionId: id, subtype: "error_aborted", report: null, costUsd: 0, turns: 0 };
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
