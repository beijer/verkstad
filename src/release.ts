// `verkstad release <n>`: puts right an issue labelled ready-for-agent that the
// Frontier holds back by mistake. A Ticket claimed with no Run working it, as a
// Run that died leaves it, is unassigned, so the Frontier offers it again (a
// branch it left stays, and the next Run Resumes it); a Spec labelled
// ready-for-agent loses the label. The verkstad sidebar's Release › runs it.

import { Failure } from "./fail.ts";
import { readFrontier } from "./frontier.ts";
import { gh } from "./gh.ts";
import { goingRun, ticketsInFlight } from "./run.ts";

const USAGE = "usage: verkstad release <n>";

export function release(args: string[]): void {
  if (args.length !== 1 || !/^[1-9]\d*$/.test(args[0])) throw new Failure(USAGE, 2);
  const n = Number(args[0]);
  const listing = readFrontier();

  if (listing.specs_labelled.some((e) => e.number === n)) {
    gh(["issue", "edit", String(n), "--remove-label", "ready-for-agent"]);
    process.stdout.write(`Released #${n}: a Spec, no longer labelled ready-for-agent.\n`);
    return;
  }
  const claimed = listing.in_progress.find((e) => e.number === n);
  if (!claimed) throw new Failure(`#${n} is neither a claimed Ticket nor a Spec labelled ready-for-agent; nothing to release`);
  const going = goingRun();
  if (going && ticketsInFlight(going.events).has(n)) throw new Failure(`#${n} is in flight in the Run going; Stop or Abort the Run first`);
  gh(["issue", "edit", String(n), "--remove-assignee", claimed.assignees.join(",")]);
  const who = claimed.assignees.map((a) => `@${a}`).join(", ");
  process.stdout.write(`Released #${n}: no longer assigned to ${who}, so the Frontier offers it again.\n`);
}
