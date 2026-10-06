// `verkstad hook pre-tool-use`: the plugin's PreToolUse hook (hooks/hooks.json). Claude Code
// sends it the event as JSON on stdin; it prints a decision as JSON on stdout, or nothing to
// leave the call to the permission system.
//
// In an agent worktree, it refuses a Bash command that feeds a heredoc into `python3 -`,
// `node -` or `cat >` (or `>>`), and names the Edit and Write tools: Claude Code's worktree
// guard refuses such a command when its text mentions git, with a message that says nothing
// about what to do instead. A command whose text does not mention git (`git` at the start of a
// word, anywhere in the text, case-insensitive) passes, as the guard lets it run. In the main checkout, outside git, and for any other command or
// tool, it prints nothing.
//
// It never exits 2, which would block the call whatever went wrong: a stdin that is not an
// event is a Failure (exit 1), which Claude Code shows the user and lets the call through.

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { Failure } from "./fail.ts";
import { inLinkedWorktree } from "./git.ts";

const USAGE = "usage: verkstad hook pre-tool-use";

const REASON =
  "verkstad: in an agent worktree, change a file with the Edit tool and create one with the Write tool, " +
  "not with a heredoc fed to python3 -, node - or cat >: Claude Code's worktree guard refuses such a command " +
  "when its text mentions git.";

/** One simple command of a Bash command line: its words, whether it reads a heredoc, and the files its stdout goes to. */
interface Segment {
  words: string[];
  heredoc: boolean;
  outputs: string[];
}

const SEPARATORS = ";&|()`";

/** Words that run the command after them, so that it is the one to look at. */
const PREFIXES = new Set(["env", "command", "exec", "nohup", "time", "then", "do", "else", "!", "{"]);

/** Reads the quoted string (`'…'`, `"…"` or `$'…'`) that opens at `i`: its text, and the index after it. */
function readQuoted(command: string, i: number): { text: string; end: number } {
  const ansi = command[i] === "$";
  if (ansi) i++;
  const quote = command[i];
  let text = "";
  let j = i + 1;
  while (j < command.length && command[j] !== quote) {
    const escapes = ansi ? "'\\" : quote === '"' ? '$`"\\\n' : "";
    if (command[j] === "\\" && escapes.includes(command[j + 1] ?? "")) j++;
    text += command[j];
    j++;
  }
  return { text, end: j + 1 };
}

/** The index of the newline that ends the line `i` is on, or the command's length. */
function lineEnd(command: string, i: number): number {
  const newline = command.indexOf("\n", i);
  return newline < 0 ? command.length : newline;
}

/**
 * Splits a Bash command into its simple commands, the way the shell would closely enough to
 * tell what a heredoc is fed into: quotes and backslashes are removed from words, comments
 * and arithmetic dropped, and a heredoc's body skipped, so that text inside a body or a quoted
 * string is never read as shell.
 */
function segments(command: string): Segment[] {
  const out: Segment[] = [];
  let segment: Segment = { words: [], heredoc: false, outputs: [] };
  let word = "";
  let inWord = false;
  // What the next word is the target of: a redirect of stdout, or another one.
  let redirect: "stdout" | "other" | null = null;
  const pending: Array<{ delimiter: string; strip: boolean }> = [];

  const endWord = () => {
    if (inWord && redirect === "stdout") segment.outputs.push(word);
    else if (inWord && redirect === null) segment.words.push(word);
    if (inWord) redirect = null;
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    redirect = null;
    if (segment.words.length || segment.heredoc) out.push(segment);
    segment = { words: [], heredoc: false, outputs: [] };
  };
  /** Skips the bodies of the heredocs the line just ended opened, returning the index after the last. */
  const skipBodies = (i: number): number => {
    for (const { delimiter, strip } of pending) {
      while (i < command.length) {
        const end = lineEnd(command, i);
        const line = command.slice(i, end);
        i = end + 1;
        if ((strip ? line.replace(/^\t+/, "") : line) === delimiter) break;
      }
    }
    pending.length = 0;
    return i;
  };

  let i = 0;
  while (i < command.length) {
    const c = command[i];
    if (c === "'" || c === '"' || command.startsWith("$'", i)) {
      const { text, end } = readQuoted(command, i);
      word += text;
      inWord = true;
      i = end;
    } else if (command.startsWith("$((", i) || (!inWord && command.startsWith("((", i))) {
      const close = command.indexOf("))", i);
      i = close < 0 ? command.length : close + 2;
      inWord = true;
    } else if (c === "\\") {
      if (command[i + 1] !== "\n") {
        word += command[i + 1] ?? "";
        inWord = true;
      }
      i += 2;
    } else if (c === "#" && !inWord) {
      i = lineEnd(command, i);
    } else if (c === "\n") {
      endSegment();
      i = skipBodies(i + 1);
    } else if (c === " " || c === "\t") {
      endWord();
      i++;
    } else if (command.startsWith("<<<", i)) {
      endWord();
      redirect = "other";
      i += 3;
    } else if (command.startsWith("<<", i)) {
      endWord();
      i += 2;
      const strip = command[i] === "-";
      if (strip) i++;
      while (command[i] === " " || command[i] === "\t") i++;
      let delimiter = "";
      while (i < command.length && !` \t\n<>${SEPARATORS}`.includes(command[i])) {
        if (command[i] === "'" || command[i] === '"') {
          const { text, end } = readQuoted(command, i);
          delimiter += text;
          i = end;
        } else {
          if (command[i] === "\\") i++;
          delimiter += command[i++] ?? "";
        }
      }
      pending.push({ delimiter, strip });
      segment.heredoc = true;
    } else if (command.startsWith("&>", i)) {
      endWord();
      i += command.startsWith("&>>", i) ? 3 : 2;
      redirect = "stdout";
    } else if (c === ">") {
      const fd = inWord && /^[0-9]+$/.test(word) ? word : "";
      if (fd) {
        word = "";
        inWord = false;
      } else endWord();
      i++;
      if (command[i] === ">" || command[i] === "|") i++;
      const duplicates = command[i] === "&" && /[0-9-]/.test(command[i + 1] ?? "");
      if (command[i] === "&") i++;
      if (duplicates) while (/[0-9-]/.test(command[i] ?? "")) i++;
      else redirect = fd === "" || fd === "1" ? "stdout" : "other";
    } else if (c === "<") {
      endWord();
      redirect = "other";
      i++;
    } else if (SEPARATORS.includes(c)) {
      endSegment();
      i++;
    } else {
      word += c;
      inWord = true;
      i++;
    }
  }
  endSegment();
  return out;
}

/** Whether a simple command feeds a heredoc into `python3 -`, `node -` or `cat >`. */
function heredocEdit(segment: Segment): boolean {
  if (!segment.heredoc) return false;
  const words = [...segment.words];
  while (words.length && (PREFIXES.has(words[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) words.shift();
  const [command, ...args] = words;
  if (command === undefined) return false;
  const name = basename(command);
  if (name === "python3" || name === "node") return args.includes("-");
  return name === "cat" && segment.outputs.some((file) => file !== "/dev/null");
}

interface ToolEvent {
  cwd?: unknown;
  tool_name?: unknown;
  tool_input?: { command?: unknown };
}

function readEvent(): ToolEvent {
  const text = readFileSync(0, "utf8");
  try {
    const event: unknown = JSON.parse(text);
    if (typeof event === "object" && event !== null && !Array.isArray(event)) return event as ToolEvent;
  } catch {
    // Reported below.
  }
  throw new Failure("stdin is not a PreToolUse event as JSON");
}

export function hook(args: string[]): void {
  if (args.length === 0) throw new Failure(`needs the hook event; ${USAGE}`, 2);
  if (args.length !== 1 || args[0] !== "pre-tool-use") throw new Failure(`no hook for '${args.join(" ")}'; ${USAGE}`, 2);
  const event = readEvent();
  const command = event.tool_input?.command;
  if (event.tool_name !== "Bash" || typeof command !== "string") return;
  if (!/\bgit/i.test(command) || !segments(command).some(heredocEdit)) return;
  const cwd = typeof event.cwd === "string" ? event.cwd : process.cwd();
  if (!existsSync(cwd) || !inLinkedWorktree(cwd)) return;
  const decision = { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: REASON };
  process.stdout.write(JSON.stringify({ hookSpecificOutput: decision }) + "\n");
}
