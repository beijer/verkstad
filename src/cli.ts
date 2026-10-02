// The verkstad command line: one module per subcommand, dispatched here.

import { Failure } from "./fail.ts";
import { frontier } from "./frontier.ts";

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
};

function usage(): string {
  const lines = Object.values(subcommands).map((s) => `  ${s.usage.padEnd(28)} ${s.summary}`);
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
