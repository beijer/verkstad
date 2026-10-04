// `verkstad hook pre-tool-use`: the plugin's PreToolUse hook (hooks/hooks.json). Claude Code
// sends it the event as JSON on stdin; it prints a decision as JSON on stdout, or nothing to
// leave the call to the permission system.
//
// In an agent worktree, it refuses a Bash command that feeds a heredoc into `python3 -`,
// `node -` or `cat >` (or `>>`), and names the Edit and Write tools: Claude Code's worktree
// guard refuses such a command when its text mentions git, with a message that says nothing
// about what to do instead. In the main checkout, outside git, and for any other command or
// tool, it prints nothing.
//
// It never exits 2, which would block the call whatever went wrong: a stdin that is not an
// event is a Failure (exit 1), which Claude Code shows the user and lets the call through.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import { Failure } from "./fail.ts";
import { tryGit } from "./git.ts";

const USAGE = "usage: verkstad hook pre-tool-use";

const REASON =
  "verkstad: in an agent worktree, change a file with the Edit tool and create one with the Write tool, " +
  "not with a heredoc fed to python3 -, node - or cat >: Claude Code's worktree guard refuses such a command " +
  "when its text mentions git.";

/** One simple command of a Bash command line: its words, and whether it reads a heredoc or writes a file. */
interface Segment {
  words: string[];
  heredoc: boolean;
  writes: boolean;
}

const SEPARATORS = ";&|()`";

/**
 * Splits a Bash command into its simple commands, the way the shell would closely enough to
 * tell what a heredoc is fed into: quotes and backslashes are removed from words, comments
 * dropped, and a heredoc's body skipped, so that text inside a body or a quoted string is
 * never read as shell.
 */
function segments(command: string): Segment[] {
  const out: Segment[] = [];
  let segment: Segment = { words: [], heredoc: false, writes: false };
  let word = "";
  let inWord = false;
  const pending: Array<{ delimiter: string; strip: boolean }> = [];

  const endWord = () => {
    if (inWord) segment.words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (segment.words.length || segment.heredoc) out.push(segment);
    segment = { words: [], heredoc: false, writes: false };
  };
  /** Reads a quoted string starting at `i`, appending its text to the word, and returns the index after it. */
  const quoted = (i: number): number => {
    const quote = command[i];
    let j = i + 1;
    while (j < command.length && command[j] !== quote) {
      if (quote === '"' && command[j] === "\\" && '$`"\\\n'.includes(command[j + 1] ?? "")) j++;
      word += command[j];
      j++;
    }
    inWord = true;
    return j + 1;
  };
  /** Skips the bodies of the heredocs the line just ended opened, returning the index after the last. */
  const skipBodies = (i: number): number => {
    for (const { delimiter, strip } of pending) {
      while (i < command.length) {
        const newline = command.indexOf("\n", i);
        const end = newline < 0 ? command.length : newline;
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
    if (c === "'" || c === '"') {
      i = quoted(i);
    } else if (c === "\\") {
      if (command[i + 1] !== "\n") {
        word += command[i + 1] ?? "";
        inWord = true;
      }
      i += 2;
    } else if (c === "#" && !inWord) {
      const newline = command.indexOf("\n", i);
      i = newline < 0 ? command.length : newline;
    } else if (c === "\n") {
      endSegment();
      i = skipBodies(i + 1);
    } else if (c === " " || c === "\t") {
      endWord();
      i++;
    } else if (command.startsWith("<<<", i)) {
      endWord();
      i += 3;
    } else if (command.startsWith("<<", i)) {
      endWord();
      i += 2;
      const strip = command[i] === "-";
      if (strip) i++;
      while (command[i] === " " || command[i] === "\t") i++;
      while (i < command.length && !` \t\n<>${SEPARATORS}`.includes(command[i])) {
        if (command[i] === "'" || command[i] === '"') i = quoted(i);
        else if (command[i] === "\\") i++;
        else word += command[i++];
      }
      pending.push({ delimiter: word, strip });
      word = "";
      inWord = false;
      segment.heredoc = true;
    } else if (c === ">") {
      const fd = inWord && /^[0-9]+$/.test(word) ? word : "";
      if (fd) {
        word = "";
        inWord = false;
      } else endWord();
      i++;
      if (command[i] === ">" || command[i] === "|") i++;
      if (command[i] === "&") i++;
      else if (fd === "" || fd === "1") segment.writes = true;
    } else if (c === "<") {
      endWord();
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
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  const [command, ...args] = words;
  if (command === undefined) return false;
  const name = basename(command);
  if (name === "python3" || name === "node") return args.includes("-");
  return name === "cat" && segment.writes;
}

/** Whether `cwd` is in a worktree of a git repo other than its main checkout. */
function inAgentWorktree(cwd: string): boolean {
  if (!existsSync(cwd)) return false;
  const top = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  const common = tryGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (top.status !== 0 || common.status !== 0) return false;
  return realpathSync(top.stdout.trim()) !== realpathSync(dirname(common.stdout.trim()));
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
  if (args.length !== 1 || args[0] !== "pre-tool-use") throw new Failure(`needs the hook event; ${USAGE}`, 2);
  const event = readEvent();
  const command = event.tool_input?.command;
  if (event.tool_name !== "Bash" || typeof command !== "string") return;
  if (!segments(command).some(heredocEdit)) return;
  const cwd = typeof event.cwd === "string" ? event.cwd : process.cwd();
  if (!inAgentWorktree(cwd)) return;
  const decision = { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: REASON };
  process.stdout.write(JSON.stringify({ hookSpecificOutput: decision }) + "\n");
}
