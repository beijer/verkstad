// `verkstad run-log [--session <id>] [--log-dir <dir>]`: a short digest of a Run for verkstad:reflect,
// so that it reads a Run's transcripts through what they say, never whole.
//
// Claude Code keeps one JSONL transcript per session in `<config>/projects/<cwd>/<session>.jsonl`, where
// `<config>` is $CLAUDE_CONFIG_DIR or ~/.claude and `<cwd>` is the directory the session ran in with every
// character but letters and digits made `-`; each subagent's transcript, and a `.meta.json` saying its type,
// description and parent, sits in `<session>/subagents/`. The Run is the last session, run in the Project's
// main checkout or one of its worktrees, that invoked verkstad:orchestrate, or the session `--session` names.
// Its time window, from the invocation to its last entry, picks the log directory's files that belong to it.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { isObject } from "./contract.ts";
import { Failure } from "./fail.ts";
import { logDirectory, mainCheckout } from "./git.ts";

const USAGE = "usage: verkstad run-log [--session <id>] [--log-dir <dir>]";
const SKILL = "verkstad:orchestrate";
/** Reflecting in the Run's own session ends the Run. */
const REFLECT = "verkstad:reflect";
/** How long after the Run's last entry a file it wrote may still have been written. */
const SLACK_MS = 60_000;
const EXAMPLES_PER_KIND = 2;
const KINDS_SHOWN = 12;
const LARGEST_SHOWN = 5;
/** The tools whose call edits a file. */
const EDITS = new Set(["Edit", "Write", "NotebookEdit"]);

type Json = Record<string, unknown>;

/** One parsed line of a transcript, with its line number. */
interface Entry {
  line: number;
  json: Json;
}

interface ToolError {
  /** `<file>:<line>` of the tool result. */
  where: string;
  agent: string;
  command: string;
  kind: string;
  denied: boolean;
}

interface ToolResult {
  /** Its text's length in characters. */
  size: number;
  /** `<file>:<line>` of the tool result. */
  where: string;
  agent: string;
  tool: string;
  subject: string;
}

/** What one transcript (the orchestrator's or an agent's) says, within the Run's window. */
interface Transcript {
  file: string;
  first: number;
  last: number;
  turns: number;
  peakContext: number;
  ownerPrompts: Array<{ at: number; text: string }>;
  errors: ToolError[];
  results: ToolResult[];
  /** How many tool calls came before the first edit; undefined when there was none. */
  callsBeforeEdit: number | undefined;
  gateRuns: number;
  gateFailures: number;
  /** The names of the Gate logs a failed Gate named. */
  failedGateLogs: string[];
  dispatches: number[];
  dispatchCount: number;
  landings: number;
  landingFailures: Array<{ ticket: number; reason: string; where: string }>;
  parks: number[];
  notifications: Array<{ taskId: string; status: string }>;
  firstPrompt: string;
  /** The agent's report: what it handed back, or else its last text. */
  finalReport: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const obj = (v: unknown): Json => (isObject(v) ? v : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** `name` without its extension `ext`. */
const stem = (name: string, ext: string): string => (name.endsWith(ext) ? name.slice(0, -ext.length) : name);

function readEntries(path: string, text = readFileSync(path, "utf8")): Entry[] {
  const entries: Entry[] = [];
  text
    .split("\n")
    .forEach((text, i) => {
      if (!text.trim()) return;
      try {
        const json: unknown = JSON.parse(text);
        if (isObject(json)) entries.push({ line: i + 1, json });
      } catch {
        // A session still being written can end in a partial line.
      }
    });
  return entries;
}

const time = (e: Entry): number => Date.parse(str(e.json.timestamp)) || 0;

/** A message's text: its string content, or its text blocks joined. */
function messageText(json: Json): string {
  const content = obj(json.message).content;
  if (typeof content === "string") return content;
  return arr(content)
    .map(obj)
    .filter((b) => b.type === "text")
    .map((b) => str(b.text))
    .join("\n");
}

function blocks(json: Json): Json[] {
  return arr(obj(json.message).content).map(obj);
}

function resultText(block: Json): string {
  const content = block.content;
  if (typeof content === "string") return content;
  return arr(content)
    .map(obj)
    .map((b) => str(b.text))
    .join("\n");
}

/** How this entry invoked `skill`, as the owner's slash command or through the Skill tool; undefined when it did not. */
function invocationOf(json: Json, skill: string): string | undefined {
  if (json.isSidechain === true) return undefined;
  if (json.type === "user" && messageText(json).includes(`<command-name>/${skill}</command-name>`)) return `/${skill}`;
  if (json.type === "assistant" && blocks(json).some((b) => b.type === "tool_use" && b.name === "Skill" && obj(b.input).skill === skill)) {
    return `Skill ${skill}`;
  }
  return undefined;
}

function isOwnerPrompt(json: Json): boolean {
  if (json.type !== "user" || json.isSidechain === true || json.isMeta === true) return false;
  const kind = str(obj(json.origin).kind);
  if (kind && kind !== "human") return false;
  if (blocks(json).some((b) => b.type === "tool_result")) return false;
  const text = messageText(json).trim();
  return text !== "" && !/^<(task-notification|command-|local-command|system-reminder)/.test(text);
}

function ticketIn(...texts: string[]): number | undefined {
  for (const text of texts) {
    const m = /#(\d+)/.exec(text);
    if (m) return Number(m[1]);
  }
  return undefined;
}

/** What a tool call was given, cut to one line: a Bash command's first line, a path, a pattern or a description. */
function callSubject(input: Json): string {
  const raw = str(input.command) || str(input.file_path) || str(input.pattern) || str(input.description) || JSON.stringify(input);
  return clip(raw.split("\n")[0].trim(), 100);
}

/** The command a tool call ran, for an example: a Bash command's first line, or the tool and what else it was given. */
function describeCall(name: string, input: Json): string {
  return clip(name === "Bash" || !name ? callSubject(input) : `${name} ${callSubject(input)}`, 100);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The simple commands of a shell command line, each as its words, without leading assignments, and `cd`s left out. */
function simpleCommands(command: string): string[][] {
  return command
    .split(/\n|&&|\|\||;|\|/)
    .map((part) => {
      const words = part.trim().split(/\s+/).filter(Boolean);
      while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
      return words;
    })
    .filter((words) => words.length && words[0] !== "cd");
}

/** The program a shell command ran: the first word of its first simple command. */
function program(command: string): string {
  return simpleCommands(command.split("\n")[0])[0]?.[0] ?? "?";
}

/** The arguments of the first `verkstad <subcommand>` (or `<subcommand>.sh` script) the command line runs. */
function verkstadCall(command: string, subcommand: string): string[] | undefined {
  for (const [first, ...rest] of simpleCommands(command)) {
    if (/(^|\/)verkstad$/.test(first) && rest[0] === subcommand) return rest.slice(1);
    if (new RegExp(`(^|/)${subcommand}\\.sh$`).test(first)) return rest;
  }
  return undefined;
}

/** What kind of error a tool result is, the same for every occurrence: paths, ids and numbers taken out. */
function errorKind(text: string, command: string): string {
  const lines = text.replace(/<\/?tool_use_error>/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  const named = lines.slice(0, 40).find((l) => /^verkstad [a-z-]+: |^(error|fatal): /i.test(l));
  let line = named ?? lines[0] ?? "";
  if (!named && /^Exit code \d+$/.test(line)) line = `exit N from ${program(command)}`;
  line = line
    .replace(/\/[^\s,'"`)]+/g, "<path>")
    .replace(/\b[0-9a-f]{8,}\b/g, "<id>")
    .replace(/\d+/g, "N");
  return clip(line, 120);
}

const DENIAL = /permission[^\n]*denied|denied by|doesn't want to proceed|rejected by the user/i;

/** What Claude Code (not verkstad) tells a worktree-isolated agent when the guard refuses a command; the transcript marks it only as an error. */
const GUARD_REFUSAL = /isolated in the worktree[^\n]*Refusing to run it/i;

/** Reads what the transcript at `path` says between `from` and `until`. */
function readTranscript(path: string, agent: string, from: number, until: number): Transcript {
  const file = basename(path);
  const t: Transcript = {
    file,
    first: Infinity,
    last: 0,
    turns: 0,
    peakContext: 0,
    ownerPrompts: [],
    errors: [],
    results: [],
    callsBeforeEdit: undefined,
    gateRuns: 0,
    gateFailures: 0,
    failedGateLogs: [],
    dispatches: [],
    dispatchCount: 0,
    landings: 0,
    landingFailures: [],
    parks: [],
    notifications: [],
    firstPrompt: "",
    finalReport: "",
  };
  const calls = new Map<string, { name: string; input: Json }>();
  const messages = new Set<string>();
  let handback = "";
  let lastText = "";
  let callCount = 0;
  for (const e of readEntries(path)) {
    const at = time(e);
    if (at && (at < from || at >= until)) continue;
    const json = e.json;
    if (at) {
      t.first = Math.min(t.first, at);
      t.last = Math.max(t.last, at);
    }
    if (json.type === "assistant") {
      const message = obj(json.message);
      const id = str(message.id) || `line-${e.line}`;
      messages.add(id);
      const u = obj(message.usage);
      t.peakContext = Math.max(t.peakContext, num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens));
      for (const b of blocks(json)) {
        if (b.type === "text" && str(b.text).trim()) lastText = str(b.text);
        if (b.type !== "tool_use") continue;
        const name = str(b.name);
        const input = obj(b.input);
        // A call the worktree guard or the permission system refused counts too: the agent spent a turn on it.
        if (EDITS.has(name) && t.callsBeforeEdit === undefined) t.callsBeforeEdit = callCount;
        callCount++;
        calls.set(str(b.id), { name, input });
        if (name === "SubagentHandback") handback = str(input.message);
        if (name === "Agent" || name === "Task") {
          t.dispatchCount++;
          const n = ticketIn(str(input.description), str(input.prompt));
          if (n !== undefined) t.dispatches.push(n);
        }
        if (name === "Bash" && verkstadCall(str(input.command), "gate")) t.gateRuns++;
      }
      continue;
    }
    // A task's notification comes as a user entry, or only as a queued one.
    const text = json.type === "user" ? messageText(json) : json.type === "queue-operation" ? str(json.content) : "";
    if (text.startsWith("<task-notification>")) {
      const status = /<status>([^<]+)<\/status>/.exec(text)?.[1] ?? "";
      for (const m of text.matchAll(/<task-id>([^<]+)<\/task-id>/g)) t.notifications.push({ taskId: m[1], status });
    }
    if (json.type !== "user") continue;
    if (!t.firstPrompt) t.firstPrompt = text;
    if (isOwnerPrompt(json)) t.ownerPrompts.push({ at, text: text.trim() });
    for (const b of blocks(json)) {
      if (b.type !== "tool_result") continue;
      const call = calls.get(str(b.tool_use_id)) ?? { name: "", input: {} };
      const output = resultText(b);
      const command = str(call.input.command);
      const where = `${file}:${e.line}`;
      t.results.push({ size: output.length, where, agent, tool: call.name || "?", subject: callSubject(call.input) });
      // A call the worktree guard or the permission system refused never ran: it is a tool error, not a Gate run or a Landing.
      const refused = b.is_error === true && (GUARD_REFUSAL.test(output) || DENIAL.test(output.slice(0, 400)));
      if (call.name === "Bash" && refused && verkstadCall(command, "gate")) t.gateRuns--;
      if (call.name === "Bash" && !refused && verkstadCall(command, "gate") && (b.is_error === true || /\bgate\b[^\n]*\bfailed\b/i.test(output))) {
        t.gateFailures++;
        const log = /Full log: (\S+)/.exec(output)?.[1];
        if (log) t.failedGateLogs.push(basename(log));
      }
      const land = call.name === "Bash" && !refused ? verkstadCall(command, "land") : undefined;
      const park = land?.[0] === "--park";
      const ticket = Number(land?.[park ? 1 : 0]);
      if (land && Number.isInteger(ticket)) {
        if (park) t.parks.push(ticket);
        else {
          t.landings++;
          const reason = /^reason: ([a-z-]+)\s*$/m.exec(output)?.[1];
          if (reason) t.landingFailures.push({ ticket, reason, where });
        }
      }
      if (b.is_error !== true) continue;
      t.errors.push({
        where,
        agent,
        command: describeCall(call.name, call.input),
        kind: errorKind(output, command),
        denied: DENIAL.test(output.slice(0, 400)),
      });
    }
  }
  t.turns = messages.size;
  t.finalReport = handback || lastText;
  if (t.first === Infinity) t.first = 0;
  return t;
}

/** Claude Code's name for the project directory of sessions run in `dir`. */
function encode(dir: string): string {
  return dir.replace(/[^A-Za-z0-9]/g, "-");
}

function projectsDir(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME || homedir(), ".claude"), "projects");
}

/** The directories holding the sessions run in the main checkout `main` or in one of its worktrees. */
function sessionDirs(main: string): string[] {
  const root = projectsDir();
  if (!existsSync(root)) return [];
  const own = encode(main);
  const worktrees = encode(join(main, ".claude", "worktrees")) + "-";
  return readdirSync(root)
    .filter((name) => name === own || name.startsWith(worktrees))
    .sort((a, b) => (a === own ? -1 : b === own ? 1 : a < b ? -1 : 1))
    .map((name) => join(root, name));
}

function sessionsIn(dirs: string[]): Array<{ id: string; path: string }> {
  return dirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ id: stem(f, ".jsonl"), path: join(dir, f) })),
  );
}

interface Run {
  id: string;
  path: string;
  /** How the Run was found: the invocation, or `--session`. */
  how: string;
  /** The Run's window: from its invocation (or its session's start) until the session invoked verkstad:reflect, if it did. */
  start: number;
  until: number;
}

/** When a session read as `entries` last invoked verkstad:orchestrate, and how; undefined when it never did. */
function lastInvocation(entries: Entry[]): { at: number; how: string } | undefined {
  let found: { at: number; how: string } | undefined;
  for (const e of entries) {
    const how = invocationOf(e.json, SKILL);
    if (how) found = { at: time(e), how };
  }
  return found;
}

/** When the session first invoked verkstad:reflect after `start`, which ends the Run; Infinity when it did not. */
function reflectedAt(entries: Entry[], start: number): number {
  const e = entries.find((e) => time(e) > start && invocationOf(e.json, REFLECT));
  return e ? time(e) : Infinity;
}

function findRun(main: string, session: string | undefined): Run {
  const dirs = sessionDirs(main);
  const sessions = sessionsIn(dirs);
  const where = dirs[0] ?? join(projectsDir(), encode(main));
  if (session !== undefined) {
    const exact = sessions.filter((s) => s.id === session);
    const matches = exact.length ? exact : sessions.filter((s) => s.id.startsWith(session));
    if (!matches.length) throw new Failure(`no session ${session} in ${where}`);
    if (matches.length > 1) {
      throw new Failure(`--session ${session} matches more than one session: ${matches.map((s) => s.id).sort().join(", ")}`);
    }
    const [s] = matches;
    const entries = readEntries(s.path);
    const start = lastInvocation(entries)?.at ?? entries.map(time).find((t) => t > 0) ?? 0;
    return { ...s, how: "named by --session", start, until: reflectedAt(entries, start) };
  }
  let found: (Run & { entries: Entry[] }) | undefined;
  for (const s of sessions) {
    const text = readFileSync(s.path, "utf8");
    if (!text.includes(SKILL)) continue;
    const entries = readEntries(s.path, text);
    const invocation = lastInvocation(entries);
    if (invocation && (!found || invocation.at > found.start)) {
      found = { ...s, how: `invoked as ${invocation.how}`, start: invocation.at, until: Infinity, entries };
    }
  }
  if (!found) throw new Failure(`no Run found: no session in ${where} invoked ${SKILL}; name one with --session <id>`);
  const { entries, ...run } = found;
  return { ...run, until: reflectedAt(entries, run.start) };
}

interface Agent {
  id: string;
  type: string;
  description: string;
  parent: string;
  transcript: Transcript;
}

function readAgents(dir: string, from: number, until: number): Agent[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith("agent-") && f.endsWith(".jsonl"))
    .map((f) => {
      const id = stem(f, ".jsonl").slice("agent-".length);
      const metaPath = join(dir, `agent-${id}.meta.json`);
      let meta: Json = {};
      try {
        meta = obj(JSON.parse(readFileSync(metaPath, "utf8")));
      } catch {
        // An agent without its meta file is still listed, by what its transcript says.
      }
      return {
        id,
        type: str(meta.agentType) || "?",
        description: str(meta.description),
        parent: str(meta.parentAgentId),
        transcript: readTranscript(join(dir, f), id, from, until),
      };
    })
    .filter((a) => a.transcript.last > 0)
    .sort((a, b) => a.transcript.first - b.transcript.first || (a.id < b.id ? -1 : 1));
}

function utc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function errorsPart(errors: ToolError[]): string {
  const denied = errors.filter((e) => e.denied).length;
  return errors.length ? `${plural(errors.length, "error")}${denied ? ` (${denied} denied)` : ""}` : "";
}

/** What an agent's report says it came to: an implementer's `status:` and `tier:`, or a Verifier's `verdict:`. */
function statusAndTier(report: string): string {
  const field = (name: string, value: string) => new RegExp(`^[*_\\s]*${name}[*_\\s]*:[*_\\s]*(${value})`, "im").exec(report)?.[1];
  const status = field("status", "[a-z]+");
  const tier = field("tier", "ok|too low");
  if (status || tier) return `status ${status ?? "-"}, tier ${tier ?? "-"}`;
  const verdict = field("verdict", "[a-z-]+(?: recorded)?");
  return verdict ? `verdict ${verdict}` : "";
}

function agentLine(a: Agent, stopped: Map<string, string>): string {
  const t = a.transcript;
  const ticket = ticketIn(a.description, t.firstPrompt);
  const parts = [
    plural(t.turns, "turn"),
    `context ${Math.round(t.peakContext / 1000)}k`,
    t.callsBeforeEdit === undefined ? "no edit" : `${plural(t.callsBeforeEdit, "call")} before first edit`,
    t.gateRuns ? `gate ${t.gateRuns}${t.gateFailures ? ` (${t.gateFailures} failed)` : ""}` : "",
    errorsPart(t.errors),
    a.parent ? `under ${a.parent}` : "",
    stopped.has(a.id) ? stopped.get(a.id)! : "",
  ].filter(Boolean);
  const fields = [a.id, a.type, ticket === undefined ? "-" : `#${ticket}`, parts.join(", "), statusAndTier(t.finalReport), `"${a.description}"`];
  return `  ${fields.filter(Boolean).join("  ")}`;
}

function errorKinds(errors: ToolError[]): string[] {
  const kinds = new Map<string, ToolError[]>();
  for (const e of errors) kinds.set(e.kind, [...(kinds.get(e.kind) ?? []), e]);
  const sorted = [...kinds.entries()].sort(([a, ea], [b, eb]) => eb.length - ea.length || (a < b ? -1 : 1));
  const lines = sorted.slice(0, KINDS_SHOWN).flatMap(([kind, es]) => {
    const agents = new Set(es.map((e) => e.agent)).size;
    const head = es.length > 1 ? `  ${es.length}x in ${plural(agents, "agent")}: ${kind}` : `  1x: ${kind}`;
    return [head, ...es.slice(0, EXAMPLES_PER_KIND).map((e) => `    ${e.where}  ${e.command}`)];
  });
  if (sorted.length > KINDS_SHOWN) lines.push(`  and ${plural(sorted.length - KINDS_SHOWN, "kind")} more, seen once or twice`);
  return lines;
}

function firstLine(text: string): string {
  return clip(text.split("\n").map((l) => l.trim()).find(Boolean) ?? "", 120);
}

/** The log directory's entries written during the Run, each with what it says in a line or two. */
function logLines(dir: string, from: number, to: number, failedGateLogs: Set<string>): string[] {
  if (!existsSync(dir)) return ["Log directory, written during the Run (0 entries)"];
  const names = readdirSync(dir)
    .filter((name) => {
      const mtime = statSync(join(dir, name)).mtimeMs;
      return mtime >= from && mtime <= to + SLACK_MS;
    })
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const read = (name: string) => readFileSync(join(dir, name), "utf8");
  const lines: string[] = [];
  const of = (re: RegExp) => names.filter((n) => re.test(n));
  for (const name of of(/^(report|conflict|verifier)-\d+\.md$/)) lines.push(`  ${name}  ${statusAndTier(read(name)) || firstLine(read(name))}`);
  for (const name of of(/^park-\d+\.md$/)) lines.push(`  ${name}  ${firstLine(read(name))}`);
  for (const name of of(/^verdict-\d+\.json$/)) {
    let verdict: Json = {};
    try {
      verdict = obj(JSON.parse(read(name)));
    } catch {
      lines.push(`  ${name}  malformed`);
      continue;
    }
    const state = str(verdict.state) || "?";
    lines.push(`  ${name}  ${state}`);
    if (state === "live-verified") continue;
    for (const c of arr(verdict.criteria).map(obj)) lines.push(`    ${clip(`${str(c.criterion)}: ${str(c.seen).replace(/\s+/g, " ")}`, 160)}`);
  }
  const gates = of(/^gate-.*\.log$/);
  const failed = gates.filter((name) => failedGateLogs.has(name));
  if (gates.length) lines.push(`  gate logs: ${gates.length}${failed.length ? `; failed: ${failed.join(", ")}` : ""}`);
  const evidence = of(/^evidence-\d+$/).length;
  if (evidence) lines.push(`  evidence directories: ${evidence}`);
  const shown = /^((report|conflict|verifier|park)-\d+\.md|verdict-\d+\.json|gate-.*\.log|evidence-\d+)$/;
  const others = new Map<string, number>();
  for (const name of names.filter((n) => !shown.test(n))) {
    const stem = name.replace(/[-.].*$/, "");
    others.set(stem, (others.get(stem) ?? 0) + 1);
  }
  for (const [stem, n] of others) lines.push(`  ${stem}-*: ${n}`);
  const head = `Log directory, written during the Run (${plural(names.length, "entry", "entries")})`;
  return [names.length ? `${head}:` : head, ...lines];
}

export function runLog(args: string[]): void {
  let session: string | undefined;
  let logDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1];
    if (args[i] === "--session" || args[i] === "--log-dir") {
      if (value === undefined || value.startsWith("--")) throw new Failure(`${args[i]} needs a value; ${USAGE}`, 2);
      if (args[i] === "--session") session = value;
      else logDir = value;
      i++;
      continue;
    }
    throw new Failure(`unknown argument '${args[i]}'; ${USAGE}`, 2);
  }

  const cwd = process.cwd();
  const main = mainCheckout(cwd);
  const run = findRun(main, session);
  const dir = logDir ?? logDirectory(cwd);
  const orchestrator = readTranscript(run.path, "orchestrator", run.start, run.until);
  const agentsDir = join(stem(run.path, ".jsonl"), "subagents");
  const agents = readAgents(agentsDir, run.start, run.until);
  const end = Math.max(orchestrator.last, ...agents.map((a) => a.transcript.last));

  const out: string[] = [
    `Run ${run.id}, ${run.how}, from ${utc(run.start)} to ${utc(end)} UTC`,
    `  Transcript: ${run.path}`,
    `  Agents' transcripts: ${agentsDir}/`,
    `  Log directory: ${dir}`,
    "",
  ];

  const prompts = orchestrator.ownerPrompts.filter((p) => p.at >= run.start || !p.at);
  out.push(`Owner prompts (${prompts.length})${prompts.length ? ":" : ""}`);
  for (const p of prompts) out.push(`  ${utc(p.at)}  ${clip(p.text.replace(/\s+/g, " "), 200)}`);
  out.push("");

  out.push(["Orchestrator: " + plural(orchestrator.turns, "turn"), errorsPart(orchestrator.errors)].filter(Boolean).join(", "));
  if (orchestrator.dispatchCount) {
    const counts = new Map<number, number>();
    for (const n of orchestrator.dispatches) counts.set(n, (counts.get(n) ?? 0) + 1);
    const again = [...counts].filter(([, c]) => c > 1).map(([n, c]) => `#${n} (${c})`);
    out.push(`  Dispatched: ${plural(orchestrator.dispatchCount, "agent")}${again.length ? `; more than once: ${again.join(", ")}` : ""}`);
  }
  if (orchestrator.landings || orchestrator.parks.length) {
    const failed = orchestrator.landingFailures.map((f) => `#${f.ticket} ${f.reason} (${f.where})`);
    out.push(
      `  Landings: ${orchestrator.landings}` +
        (failed.length ? `; failed: ${failed.join(", ")}` : "") +
        (orchestrator.parks.length ? `; Parked: ${orchestrator.parks.map((n) => `#${n}`).join(", ")}` : ""),
    );
  }
  out.push("");

  const stopped = new Map<string, string>();
  for (const n of orchestrator.notifications) if (n.status && n.status !== "completed") stopped.set(n.taskId, n.status);
  out.push(`Agents (${agents.length})${agents.length ? ":" : ""}`);
  for (const a of agents) out.push(agentLine(a, stopped));
  out.push("");

  const errors = [...orchestrator.errors, ...agents.flatMap((a) => a.transcript.errors)];
  if (errors.length) out.push(`Tool errors (${errors.length}), by kind:`, ...errorKinds(errors), "");

  const largest = [orchestrator, ...agents.map((a) => a.transcript)]
    .flatMap((t) => t.results)
    .sort((a, b) => b.size - a.size)
    .slice(0, LARGEST_SHOWN);
  if (largest.length) {
    out.push("Largest tool results:");
    for (const r of largest) out.push(`  ${(r.size / 1000).toFixed(1)}k  ${r.agent}  ${r.tool}  ${r.subject}  ${r.where}`);
    out.push("");
  }

  out.push(...logLines(dir, run.start, end, new Set([orchestrator, ...agents.map((a) => a.transcript)].flatMap((t) => t.failedGateLogs))));
  process.stdout.write(out.join("\n") + "\n");
}
