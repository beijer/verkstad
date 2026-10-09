// The verkstad command line: one module per subcommand, dispatched here.

import { conflicts } from "./conflicts.ts";
import { convertLinks } from "./convert-links.ts";
import { Failure } from "./fail.ts";
import { frontier } from "./frontier.ts";
import { gate } from "./gate.ts";
import { hook } from "./hook.ts";
import { labels } from "./labels.ts";
import { land } from "./land.ts";
import { prune } from "./prune.ts";
import { review } from "./review.ts";
import { run } from "./run.ts";
import { runLog } from "./run-log.ts";
import { start } from "./start.ts";
import { surfaces } from "./surfaces.ts";
import { verdict } from "./verdict.ts";

interface Subcommand {
  usage: string;
  summary: string;
  run(args: string[]): void | Promise<void>;
}

const subcommands: Record<string, Subcommand> = {
  frontier: {
    usage: "verkstad frontier [--json]",
    summary: "Lists the Tickets that are ready, in progress and waiting, and what each waits on",
    run: frontier,
  },
  conflicts: {
    usage: "verkstad conflicts <n> [--rebase <worktree>]",
    summary:
      "Fetches and prints the files a rebase of issue-<n> onto origin's base branch would conflict in, exiting 1 if any; " +
      "--rebase rebases a clean <worktree> on issue-<n> onto it when there are none",
    run: conflicts,
  },
  "convert-links": {
    usage: "verkstad convert-links [--dry-run]",
    summary: "Turns the parent and blockers open issues name in their text into native sub-issue and blocked_by links",
    run: convertLinks,
  },
  gate: {
    usage: "verkstad gate [--quick]",
    summary: "Runs the Contract's Gate steps, printing only failures and the full log's path",
    run: gate,
  },
  hook: {
    usage: "verkstad hook pre-tool-use",
    summary: "Refuses, as the plugin's PreToolUse hook, a Bash command whose unquoted =word zsh would expand, saying how to quote it",
    run: hook,
  },
  land: {
    usage: "verkstad land [--park] <n> <worktree> <file>",
    summary: "Lands Ticket #n's branch with the report in <file>; --park Parks it with the reason in <file>",
    run: land,
  },
  labels: {
    usage: "verkstad labels [--dry-run]",
    summary: "Creates the five triage labels on GitHub, skipping those the repo has",
    run: labels,
  },
  prune: {
    usage: "verkstad prune",
    summary: "Deletes what the log directory holds once it is older than 30 days",
    run: prune,
  },
  review: {
    usage: "verkstad review record",
    summary: "Records that the branch here was reviewed, at the commit HEAD is on, for Landing to check",
    run: review,
  },
  run: {
    usage: "verkstad run [--max <n>] [--parallel <n>] [--budget <usd>] [--dry-run] | --stop | --abort",
    summary:
      "Works the Frontier, one Ticket at a time or --parallel <n> side by side: a headless session implements each in its own worktree, " +
      "the Verifier Walks it when it touches a Surface, and it lands or is Parked; --stop ends the Run going after its Tickets in flight, " +
      "--abort ends it now and discards their work",
    run,
  },
  "run-log": {
    usage: "verkstad run-log [--run <file>]",
    summary: "Digests the last Run's event log, and its sessions' failed tool calls, for verkstad:reflect",
    run: runLog,
  },
  start: {
    usage: "verkstad start <n> [--resume]",
    summary: "Puts this agent worktree on issue-<n>, made from or rebased onto origin's base branch, and deletes its own branch",
    run: start,
  },
  surfaces: {
    usage: "verkstad surfaces <base> [--json]",
    summary: "Lists the Surfaces whose globs match what the branch changed since it left <base>",
    run: surfaces,
  },
  verdict: {
    usage: "verkstad verdict record|check|evidence <n> …",
    summary: "Records Ticket #n's Verdict, checks it lets the Ticket land, or prints its Evidence directory",
    run: verdict,
  },
};

function usage(): string {
  const lines = Object.values(subcommands).map((s) => `  ${s.usage.padEnd(46)} ${s.summary}`);
  return ["usage: verkstad <subcommand> [options]", "", ...lines, ""].join("\n");
}

async function main(argv: string[]): Promise<number> {
  const [name, ...args] = argv;
  if (name === "help" || name === "--help" || name === "-h") {
    process.stdout.write(usage());
    return 0;
  }
  if (name === undefined) {
    process.stderr.write(usage());
    return 2;
  }
  const subcommand = subcommands[name];
  if (!subcommand) {
    process.stderr.write(`verkstad: no subcommand '${name}'\n\n${usage()}`);
    return 2;
  }
  try {
    await subcommand.run(args);
    return 0;
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    process.stderr.write(`verkstad ${name}: ${error.message}\n`);
    return error.code;
  }
}

process.exitCode = await main(process.argv.slice(2));
