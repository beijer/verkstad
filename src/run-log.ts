// `verkstad run-log [--run <file>]`: a short digest of a Run for verkstad:reflect, so that it sees where a
// Run's turns and dollars went without reading every transcript.
//
// A Run (src/run.ts) writes its event log, `run-<time>.jsonl` in the log directory, one JSON object per line:
// a Ticket claimed on its Tier, each session (role, id, ending, cost, turns, status), a Resume and its Tier,
// each CLI call (what a failed one said), each Landing, each Park and each abort, and the Run's start and end. The digest
// reads the last one, or the one `--run` names, and for each session finds its transcript by its id among
// Claude Code's transcripts for the Project's main checkout and worktrees (src/transcripts.ts) and counts the
// tool calls that failed there, by kind.

import { existsSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Failure } from "./fail.ts";
import { logDirectory, mainCheckout } from "./git.ts";
import { FAILURE_KINDS, failedToolCalls, readJsonLines, sessionDirs } from "./transcripts.ts";

const USAGE = "usage: verkstad run-log [--run <file>]";

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function usd(amount: number): string {
  return `$${amount.toFixed(2).replace(/\.00$/, "")}`;
}

function utc(at: string): string {
  return at.slice(0, 16).replace("T", " ");
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function firstLine(text: string): string {
  return clip(text.split("\n").map((l) => l.trim()).find(Boolean) ?? "", 200);
}

/** How a session ended, from Claude Code's result subtype (or verkstad's own `error_timeout` and `error_aborted`). */
const ENDINGS: Record<string, string> = {
  success: "ended",
  error_max_turns: "stopped at its turn limit",
  error_max_budget_usd: "spent its budget",
  error_timeout: "ran out of time",
  error_aborted: "killed when the owner aborted the Run",
};

/** The transcript line for session `id`: where it is and its failed tool calls by kind, or that it is gone. */
function transcriptLine(id: string, dirs: string[]): string {
  if (!id) return "no session id: the session did not start";
  const found = failedToolCalls(id, dirs);
  if (!found) return `transcript gone: no ${id}.jsonl among the Project's sessions`;
  const { path, kinds, total } = found;
  if (!total) return `${path}: no failed tool calls`;
  const parts = FAILURE_KINDS.filter((k) => kinds.has(k)).map((k) => plural(kinds.get(k)!, k));
  return `${path}: ${plural(total, "failed tool call")}: ${parts.join(", ")}`;
}

/** What a failed `verkstad` call said, without its `verkstad <subcommand>:` prefix and a `reason:` line. */
function failureMessage(stderr: string): string {
  const lines = stderr.split("\n").filter((l) => !/^reason: /.test(l));
  return firstLine(lines.join("\n").replace(/^verkstad [a-z-]+: /, ""));
}

interface Ticket {
  n: number;
  title: string;
  tiers: string[];
  lines: string[];
  outcome: "landed" | "parked" | "aborted" | null;
}

/** The event log to digest: the one `--run` names, here or in the log directory, or else the log directory's last. */
function findEventLog(dir: string, named: string | undefined): string | null {
  if (named !== undefined) {
    const found = [resolve(named), join(dir, named)].find(existsSync);
    if (!found) throw new Failure(`no event log ${named}, here or in ${dir}`);
    return found;
  }
  const logs = existsSync(dir) ? readdirSync(dir).filter((name) => /^run-.*\.jsonl$/.test(name)).sort() : [];
  return logs.length ? join(dir, logs[logs.length - 1]) : null;
}

export function runLog(args: string[]): void {
  let named: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--run") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Failure(`--run needs a value; ${USAGE}`, 2);
      named = value;
      i++;
      continue;
    }
    throw new Failure(`unknown argument '${args[i]}'; ${USAGE}`, 2);
  }

  const cwd = process.cwd();
  const dir = logDirectory(cwd);
  const file = findEventLog(dir, named);
  if (!file) {
    process.stdout.write(`No Run to digest: ${dir} holds no run-*.jsonl.\n`);
    return;
  }
  const transcriptDirs = sessionDirs(mainCheckout(cwd));
  const events = readJsonLines(file);

  const tickets = new Map<number, Ticket>();
  let current: Ticket | undefined;
  const ticketOf = (n: number): Ticket => {
    let t = tickets.get(n);
    if (!t) tickets.set(n, (t = { n, title: "", tiers: [], lines: [], outcome: null }));
    return (current = t);
  };
  /** Failed CLI calls made while the Run was on no Ticket. */
  const outside: string[] = [];
  const seen = new Set<string>();
  let sessions = 0;
  let cost = 0;
  let turns = 0;
  let ending = "did not end (it is still going, or was killed)";

  for (const e of events) {
    if (e.run === "finished") ending = e.asked === "stop" ? "finished, stopped at the owner's request" : "finished";
    if (e.run === "aborted") ending = "aborted by the owner";
    if (e.run === "stopped") ending = `stopped: ${firstLine(str(e.error))}`;
    // A CLI call names no Ticket: it belongs to the Ticket the Run is on, if it is on one.
    if (Array.isArray(e.verkstad)) {
      const [subcommand, ...rest] = e.verkstad.map(str);
      if (num(e.code) === 0) continue;
      const message = failureMessage(str(e.stderr));
      const reason = /^reason: (\S+)\s*$/m.exec(str(e.stderr))?.[1];
      (current?.lines ?? outside).push(
        subcommand === "land" && rest[0] !== "--park" && reason ? `  Landing failed: ${reason}: ${message}` : `  verkstad ${subcommand} failed: ${message}`,
      );
      continue;
    }
    if (typeof e.ticket !== "number") continue;
    const t = ticketOf(e.ticket);
    if (typeof e.claimed === "string") t.title = e.claimed;
    if (typeof e.tier === "string" && t.tiers[t.tiers.length - 1] !== e.tier) t.tiers.push(e.tier);
    if (typeof e.resumed === "string") t.lines.push(`  Resumed on the ${str(e.tier)} Tier: ${firstLine(e.resumed)}`);
    if (typeof e.session === "string") {
      const id = str(e.id);
      const subtype = str(e.subtype);
      sessions++;
      cost += num(e.cost);
      turns += num(e.turns);
      const parts = [ENDINGS[subtype] ?? subtype, usd(num(e.cost)), plural(num(e.turns), "turn"), e.status ? `status ${str(e.status)}` : ""];
      t.lines.push(`  ${e.session}: ${parts.filter(Boolean).join(", ")}`);
      // A session resumed to give its report goes on in the same transcript.
      t.lines.push(`    ${id && seen.has(id) ? "the same session as above" : transcriptLine(id, transcriptDirs)}`);
      seen.add(id);
    }
    if (typeof e.landed === "string") {
      t.lines.push(`  ${e.landed}`);
      t.outcome = "landed";
      current = undefined;
    }
    if (typeof e.parked === "string") {
      t.lines.push(`  parked: ${firstLine(e.parked)}`);
      t.outcome = "parked";
      current = undefined;
    }
    if (typeof e.aborted === "string") {
      t.lines.push(`  aborted: its work was discarded: ${e.aborted}`);
      t.outcome = "aborted";
      current = undefined;
    }
  }

  const first = str(events[0]?.at);
  const last = str(events[events.length - 1]?.at);
  const until = last.slice(0, 10) === first.slice(0, 10) ? last.slice(11, 16) : utc(last);
  const out = [`Run ${basename(file)}, ${utc(first)} to ${until} UTC: ${ending}`, `  Event log: ${file}`, ...outside, ""];
  for (const t of tickets.values()) {
    out.push(`#${t.n} ${t.title || "(untitled)"}: ${t.tiers.length ? `${t.tiers[0]} Tier${t.tiers.slice(1).map((tier) => `, then ${tier}`).join("")}` : "Tier unknown"}`);
    out.push(...t.lines);
    if (!t.outcome) out.push(`  no outcome: the Run ended before #${t.n} landed or was Parked`);
    out.push("");
  }
  const all = [...tickets.values()];
  const count = (o: Ticket["outcome"]) => all.filter((t) => t.outcome === o).length;
  out.push(
    `Totals: ${plural(all.length, "Ticket")} (${count("landed")} landed, ${count("parked")} parked), ` +
      `${plural(sessions, "session")}, ${usd(cost)}, ${plural(turns, "turn")}`,
  );
  process.stdout.write(out.join("\n") + "\n");
}
