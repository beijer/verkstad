// The verkstad command line: one module per subcommand, dispatched here.

import { convertLinks } from "./convert-links.ts";
import { Failure } from "./fail.ts";
import { frontier } from "./frontier.ts";
import { gate } from "./gate.ts";
import { labels } from "./labels.ts";
import { land } from "./land.ts";
import { prune } from "./prune.ts";
import { review } from "./review.ts";
import { runLog } from "./run-log.ts";
import { start } from "./start.ts";
import { surfaces } from "./surfaces.ts";
import { verdict } from "./verdict.ts";

interface Subcommand {
  usage: string;
  summary: string;
  run(args: string[]): void;
}

const subcommands: Record<string, Subcommand> = {
  frontier: {
    usage: "verkstad frontier [--json]",
    summary: "Lists the Tickets that are ready, in progress and waiting, and what each waits on",
    run: frontier,
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
  "run-log": {
    usage: "verkstad run-log [--session <id>] [--log-dir <dir>]",
    summary: "Digests the last Run's transcripts and log files for verkstad:reflect",
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

function main(argv: string[]): number {
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
    subcommand.run(args);
    return 0;
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    process.stderr.write(`verkstad ${name}: ${error.message}\n`);
    return error.code;
  }
}

process.exitCode = main(process.argv.slice(2));
