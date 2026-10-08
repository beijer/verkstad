// `verkstad run-log [--run <file>]`: a short digest of a Run for verkstad:reflect, so that it sees where a
// Run's turns and dollars went without reading every transcript.
//
// A Run (src/run.ts) writes its event log, `run-<time>.jsonl` in the log directory, one JSON object per line:
// a Ticket claimed on its Tier, each session (role, id, ending, cost, turns, status), a Resume and its Tier,
// each CLI call (what a failed one said), each Landing and each Park, and the Run's start and end. The digest
// reads the last one, or the one `--run` names, and for each session finds its transcript by its id among
// Claude Code's transcripts for the Project's main checkout and worktrees (`<config>/projects/<cwd>/<id>.jsonl`,
// `<config>` being $CLAUDE_CONFIG_DIR or ~/.claude and `<cwd>` the directory the session ran in with every
// character but letters and digits made `-`) and counts the tool calls that failed there, by kind.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { isObject } from "./contract.ts";
import { Failure } from "./fail.ts";
import { logDirectory, mainCheckout } from "./git.ts";

const USAGE = "usage: verkstad run-log [--run <file>]";

type Json = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const obj = (v: unknown): Json => (isObject(v) ? v : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

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

/** A file's JSON lines, skipping a partial last line of a file still being written. */
function readLines(path: string): Json[] {
  const lines: Json[] = [];
  for (const text of readFileSync(path, "utf8").split("\n")) {
    if (!text.trim()) continue;
    try {
      const json: unknown = JSON.parse(text);
      if (isObject(json)) lines.push(json);
    } catch {
      // A Run or a session still going can end in a partial line.
    }
  }
  return lines;
}

/** How a session ended, from Claude Code's result subtype (or verkstad's own `error_timeout`). */
const ENDINGS: Record<string, string> = {
  success: "ended",
  error_max_turns: "stopped at its turn limit",
  error_max_budget_usd: "spent its budget",
  error_timeout: "ran out of time",
};

/** Claude Code's name for the project directory of sessions run in `dir`. */
function encode(dir: string): string {
  return dir.replace(/[^A-Za-z0-9]/g, "-");
}

/** The directories holding the transcripts of sessions run in the main checkout `main` or one of its worktrees. */
function sessionDirs(main: string): string[] {
  const root = join(process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME || homedir(), ".claude"), "projects");
  if (!existsSync(root)) return [];
  const own = encode(main);
  const worktrees = encode(join(main, ".claude", "worktrees")) + "-";
  return readdirSync(root)
    .filter((name) => name === own || name.startsWith(worktrees))
    .map((name) => join(root, name));
}

/** What a failed tool call was: refused by a hook, denied by the permission system, or a call that ran and failed. */
function failureKind(text: string): "hook refusal" | "permission denial" | "failed command" {
  const head = text.replace(/<\/?tool_use_error>/g, "").trim().slice(0, 400);
  if (/^PreToolUse:\S+ hook\b/.test(head)) return "hook refusal";
  if (/permission[^\n]*denied|denied by|doesn't want to proceed|rejected by the user/i.test(head)) return "permission denial";
  return "failed command";
}

function resultText(block: Json): string {
  const content = block.content;
  if (typeof content === "string") return content;
  return arr(content)
    .map(obj)
    .map((b) => str(b.text))
    .join("\n");
}

/** The transcript line for session `id`: where it is and its failed tool calls by kind, or that it is gone. */
function transcriptLine(id: string, dirs: string[]): string {
  if (!id) return "no session id: the session did not start";
  const path = dirs.map((dir) => join(dir, `${id}.jsonl`)).find(existsSync);
  if (!path) return `transcript gone: no ${id}.jsonl among the Project's sessions`;
  const kinds = new Map<string, number>();
  for (const line of readLines(path)) {
    if (line.type !== "user") continue;
    for (const block of arr(obj(line.message).content).map(obj)) {
      if (block.type !== "tool_result" || block.is_error !== true) continue;
      const kind = failureKind(resultText(block));
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    }
  }
  const total = [...kinds.values()].reduce((a, b) => a + b, 0);
  if (!total) return `${path}: no failed tool calls`;
  const parts = ["hook refusal", "permission denial", "failed command"].filter((k) => kinds.has(k)).map((k) => plural(kinds.get(k)!, k));
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
  outcome: "landed" | "parked" | null;
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
  const dirs = sessionDirs(mainCheckout(cwd));
  const events = readLines(file);

  const tickets = new Map<number, Ticket>();
  let current: Ticket | undefined;
  const ticket = (n: number): Ticket => {
    let t = tickets.get(n);
    if (!t) tickets.set(n, (t = { n, title: "", tiers: [], lines: [], outcome: null }));
    return (current = t);
  };
  const seen = new Set<string>();
  let sessions = 0;
  let cost = 0;
  let turns = 0;
  let ending = "did not end (it is still going, or was killed)";

  for (const e of events) {
    if (e.run === "finished") ending = "finished";
    if (e.run === "stopped") ending = `stopped: ${firstLine(str(e.error))}`;
    // A CLI call names no Ticket: it belongs to the Ticket the Run is on.
    if (Array.isArray(e.verkstad)) {
      const [subcommand, ...rest] = e.verkstad.map(str);
      if (!current || num(e.code) === 0) continue;
      const message = failureMessage(str(e.stderr));
      const reason = /^reason: (\S+)\s*$/m.exec(str(e.stderr))?.[1];
      current.lines.push(
        subcommand === "land" && rest[0] !== "--park" && reason ? `  Landing failed: ${reason}: ${message}` : `  verkstad ${subcommand} failed: ${message}`,
      );
      continue;
    }
    if (typeof e.ticket !== "number") continue;
    const t = ticket(e.ticket);
    if (typeof e.claimed === "string") t.title = e.claimed;
    if (typeof e.tier === "string" && t.tiers[t.tiers.length - 1] !== e.tier) t.tiers.push(e.tier);
    if (typeof e.session === "string") {
      const id = str(e.id);
      const subtype = str(e.subtype);
      sessions++;
      cost += num(e.cost);
      turns += num(e.turns);
      const parts = [ENDINGS[subtype] ?? subtype, usd(num(e.cost)), plural(num(e.turns), "turn"), e.status ? `status ${str(e.status)}` : ""];
      t.lines.push(`  ${e.session}: ${parts.filter(Boolean).join(", ")}`);
      // A session resumed to give its report goes on in the same transcript.
      t.lines.push(`    ${id && seen.has(id) ? "the same session as above" : transcriptLine(id, dirs)}`);
      seen.add(id);
    }
    if (typeof e.landed === "string") {
      t.lines.push(`  ${e.landed}`);
      t.outcome = "landed";
    }
    if (typeof e.parked === "string") {
      t.lines.push(`  parked: ${firstLine(e.parked)}`);
      t.outcome = "parked";
    }
  }

  const first = str(events[0]?.at);
  const last = str(events[events.length - 1]?.at);
  const out = [`Run ${basename(file)}, ${utc(first)} to ${last.slice(11, 16)} UTC: ${ending}`, `  Event log: ${file}`, ""];
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
