// `verkstad labels [--dry-run]`: creates on GitHub the five triage labels the
// loop and its skills use (docs/agents/triage-labels.md maps the roles to them),
// skipping any the repo has. GitHub's label names are unique regardless of case,
// so `Needs-Triage` counts as `needs-triage`. It prints one line per label;
// --dry-run reads the labels and creates none.

import { Failure } from "./fail.ts";
import { gh, ghJson } from "./gh.ts";

const USAGE = "usage: verkstad labels [--dry-run]";

/** The triage labels, in the order docs/agents/triage-labels.md lists their roles. */
const TRIAGE_LABELS = [
  { name: "needs-triage", description: "Maintainer needs to evaluate this issue", color: "fbca04" },
  { name: "needs-info", description: "Waiting on reporter for more information", color: "d876e3" },
  { name: "ready-for-agent", description: "Fully specified, ready for an AFK agent", color: "0e8a16" },
  { name: "ready-for-human", description: "Requires human implementation", color: "1d76db" },
  { name: "wontfix", description: "This will not be worked on", color: "ffffff" },
];

function parseArgs(args: string[]): { dryRun: boolean } {
  let dryRun = false;
  for (const arg of args) {
    if (arg === "--dry-run") dryRun = true;
    else throw new Failure(`unknown option '${arg}'; ${USAGE}`, 2);
  }
  return { dryRun };
}

export function labels(args: string[]): void {
  const { dryRun } = parseArgs(args);
  const existing = ghJson<Array<{ name: string }>>(["label", "list", "--json", "name", "--limit", "1000"]);
  const width = Math.max(...TRIAGE_LABELS.map((l) => l.name.length)) + 1;
  for (const label of TRIAGE_LABELS) {
    const found = existing.find((e) => e.name.toLowerCase() === label.name.toLowerCase());
    let outcome: string;
    if (found) {
      outcome = found.name === label.name ? "exists" : `exists as ${found.name}`;
    } else if (dryRun) {
      outcome = "would create";
    } else {
      try {
        gh(["label", "create", label.name, "--description", label.description, "--color", label.color]);
      } catch (error) {
        if (!(error instanceof Failure)) throw error;
        throw new Failure(`could not create ${label.name}: ${error.message}`);
      }
      outcome = "created";
    }
    process.stdout.write(`${label.name.padEnd(width)} ${outcome}\n`);
  }
}
