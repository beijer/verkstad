// Claude Code's transcripts of the sessions a Run started: `verkstad run` counts each session's failed tool
// calls for its summary, and `verkstad run-log` shows them by kind. Claude Code keeps a session's transcript at
// `<config>/projects/<cwd>/<id>.jsonl`, `<config>` being $CLAUDE_CONFIG_DIR or ~/.claude and `<cwd>` the
// directory the session ran in with every character but letters and digits made `-`.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isObject } from "./contract.ts";

type Json = Record<string, unknown>;

/** A file's JSON lines, skipping a partial last line of a file still being written. */
export function readJsonLines(path: string): Json[] {
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

/** Claude Code's name for the project directory of sessions run in `dir`. */
function encode(dir: string): string {
  return dir.replace(/[^A-Za-z0-9]/g, "-");
}

/** The directories holding the transcripts of sessions run in the main checkout `main` or one of its worktrees. */
export function sessionDirs(main: string): string[] {
  const root = join(process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME || homedir(), ".claude"), "projects");
  if (!existsSync(root)) return [];
  const own = encode(main);
  const worktrees = encode(join(main, ".claude", "worktrees")) + "-";
  return readdirSync(root)
    .filter((name) => name === own || name.startsWith(worktrees))
    .map((name) => join(root, name));
}

export const FAILURE_KINDS = ["hook refusal", "permission denial", "failed command"] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

/** What a failed tool call was: refused by a hook, denied by the permission system, or a call that ran and failed. */
function failureKind(text: string): FailureKind {
  const head = text.replace(/<\/?tool_use_error>/g, "").trim().slice(0, 400);
  if (/^PreToolUse:\S+ hook\b/.test(head)) return "hook refusal";
  if (/permission[^\n]*denied|denied by|requested permissions? to use|doesn't want to proceed|rejected by the user/i.test(head)) return "permission denial";
  return "failed command";
}

function resultText(block: Json): string {
  const content = block.content;
  if (typeof content === "string") return content;
  return (Array.isArray(content) ? content : [])
    .filter(isObject)
    .map((b) => (typeof b.text === "string" ? b.text : ""))
    .join("\n");
}

/** Session `id`'s transcript, found among `dirs`, and its failed tool calls by kind; null when it is gone. */
export function failedToolCalls(id: string, dirs: string[]): { path: string; kinds: Map<FailureKind, number>; total: number } | null {
  const path = dirs.map((dir) => join(dir, `${id}.jsonl`)).find(existsSync);
  if (!path) return null;
  const kinds = new Map<FailureKind, number>();
  for (const line of readJsonLines(path)) {
    if (line.type !== "user" || !isObject(line.message) || !Array.isArray(line.message.content)) continue;
    for (const block of line.message.content.filter(isObject)) {
      if (block.type !== "tool_result" || block.is_error !== true) continue;
      const kind = failureKind(resultText(block));
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    }
  }
  return { path, kinds, total: [...kinds.values()].reduce((a, b) => a + b, 0) };
}
