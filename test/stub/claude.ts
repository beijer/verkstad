// A stub `claude`: plays the headless sessions a test scripts, in order. Each
// call takes the next StubSession from $VERKSTAD_CLAUDE_STUB_DIR/sessions.json
// scripted for the calling Ticket, the one whose worktree (issue-<n>) it runs
// in, or for any Ticket; it takes it under a lock, since a Run that works
// Tickets side by side starts several sessions at once. It
// appends its argv, working directory and prompt to calls.jsonl, runs the
// session's commands in its working directory as an agent would, and prints a
// result as `claude -p --output-format json` does. It accepts exactly the flags
// verkstad passes, checks the report against --json-schema, and fails loudly on
// anything else, as on a call no session was scripted for. Like Claude Code, it
// appends the session's tool calls to its transcript, under
// `<$CLAUDE_CONFIG_DIR or ~/.claude>/projects/<cwd, every character but letters and digits made ->/<id>.jsonl`.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { StubSession } from "./state.ts";

const VALUE_FLAGS = [
  "--model",
  "--effort",
  "--max-turns",
  "--append-system-prompt",
  "--json-schema",
  "--permission-mode",
  "--permission-prompts",
  "--output-format",
  "--session-id",
  "--resume",
  "--max-budget-usd",
  "--disallowedTools",
  "--add-dir",
];
const BOOLEAN_FLAGS = ["-p"];

/** The verkstad checkout this stub belongs to, whose `bin/` the session's commands find `verkstad` in. */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function parse(args: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (BOOLEAN_FLAGS.includes(arg)) flags.set(arg, "");
    else if (VALUE_FLAGS.includes(arg) && i + 1 < args.length) flags.set(arg, args[++i]);
    else throw new Error(`unsupported argument ${JSON.stringify(arg)}`);
  }
  return flags;
}

type Schema = { type?: string; enum?: unknown[]; required?: string[]; properties?: Record<string, Schema>; items?: Schema; minItems?: number };

/** Checks `value` against the parts of JSON Schema verkstad's schemas use; throws naming the first mismatch. */
function check(value: unknown, schema: Schema, at: string): void {
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${at} is ${JSON.stringify(value)}, not one of ${JSON.stringify(schema.enum)}`);
  const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (schema.type && schema.type !== type) throw new Error(`${at} is ${type}, not ${schema.type}`);
  if (type === "object") {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in object)) throw new Error(`${at} lacks ${key}`);
    for (const [key, v] of Object.entries(object)) {
      const property = schema.properties?.[key];
      if (!property) throw new Error(`${at} has ${key}, which the schema does not`);
      check(v, property, `${at}.${key}`);
    }
  }
  if (type === "array" && (value as unknown[]).length < (schema.minItems ?? 0)) throw new Error(`${at} has fewer than ${schema.minItems} items`);
  if (type === "array" && schema.items) (value as unknown[]).forEach((v, i) => check(v, schema.items as Schema, `${at}[${i}]`));
}

/** Appends a tool call per command, and `failed` failing ones, to session `id`'s transcript. */
function transcribe(id: string, commands: string[], failed: number): void {
  const config = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME ?? "", ".claude");
  const dir = join(config, "projects", process.cwd().replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const results: Array<[string, boolean]> = [...commands.map((c): [string, boolean] => [c, false]), ...Array.from({ length: failed }, (): [string, boolean] => ["Exit code 1", true])];
  const lines = results.flatMap(([text, isError]) => {
    const use = randomUUID();
    return [
      { type: "assistant", sessionId: id, message: { role: "assistant", content: [{ type: "tool_use", id: use, name: "Bash", input: { command: text } }] } },
      { type: "user", sessionId: id, message: { role: "user", content: [{ type: "tool_result", tool_use_id: use, content: isError ? text : "", is_error: isError }] } },
    ];
  });
  appendFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l) + "\n").join(""));
}

/**
 * Takes the first session scripted for Ticket `ticket` or for any Ticket off the queue in `dir`, holding the
 * lock directory `dir`/lock while it reads and writes the queue, so that two sessions starting at once each take
 * their own.
 */
function take(dir: string, ticket: number | undefined, prompt: string): StubSession {
  const lock = join(dir, "lock");
  for (const until = Date.now() + 10_000; ; ) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() > until) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    const queuePath = join(dir, "sessions.json");
    const queue = JSON.parse(readFileSync(queuePath, "utf8")) as StubSession[];
    const at = queue.findIndex((s) => s.ticket === undefined || s.ticket === ticket);
    if (at === -1) {
      const whose = ticket === undefined ? "" : ` for #${ticket}`;
      throw new Error(`no session is scripted${whose} for the prompt starting ${JSON.stringify(prompt.slice(0, 80))}`);
    }
    const [session] = queue.splice(at, 1);
    writeFileSync(queuePath, JSON.stringify(queue, null, 2) + "\n");
    return session;
  } finally {
    rmdirSync(lock);
  }
}

function main(): number {
  const dir = process.env.VERKSTAD_CLAUDE_STUB_DIR;
  if (!dir) {
    process.stderr.write("stub claude: VERKSTAD_CLAUDE_STUB_DIR is not set; the stub runs only inside a test\n");
    return 1;
  }
  const args = process.argv.slice(2);
  const prompt = readFileSync(0, "utf8");
  appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({ args, cwd: process.cwd(), prompt }) + "\n");
  try {
    const flags = parse(args);
    for (const [flag, wanted] of [["-p", ""], ["--output-format", "json"], ["--permission-prompts", "none"]]) {
      if (flags.get(flag) !== wanted) throw new Error(`verkstad must pass ${flag}${wanted ? ` ${wanted}` : ""}`);
    }
    if (!prompt.trim()) throw new Error("no prompt on stdin");
    const ticket = /\/issue-(\d+)$/.exec(process.cwd())?.[1];
    const session = take(dir, ticket === undefined ? undefined : Number(ticket), prompt);

    const env = { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` };
    for (const command of session.run ?? []) {
      const r = spawnSync("sh", ["-c", command], { env, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`the session's command ${JSON.stringify(command)} failed: ${r.stderr.trim() || r.stdout.trim()}`);
    }
    if (session.report) {
      const schema = flags.get("--json-schema");
      if (!schema) throw new Error("a report needs --json-schema");
      check(session.report, JSON.parse(schema) as Schema, "the report");
    }
    const subtype = session.subtype ?? "success";
    const id = flags.get("--resume") ?? flags.get("--session-id") ?? randomUUID();
    transcribe(id, session.run ?? [], session.failedToolCalls ?? 0);
    const result = {
      type: "result",
      subtype,
      is_error: subtype !== "success",
      session_id: id,
      num_turns: 12,
      total_cost_usd: session.cost ?? 0.25,
      result: subtype === "success" ? "Reported." : "",
      ...(session.report ? { structured_output: session.report } : {}),
    };
    process.stdout.write(JSON.stringify(result) + "\n");
    return 0;
  } catch (error) {
    process.stderr.write(`stub claude: ${(error as Error).message}\n`);
    return 1;
  }
}

process.exitCode = main();
