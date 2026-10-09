// `verkstad run [--max <n>] [--parallel <n>] [--budget <usd>] [--dry-run]`: a
// Run. From the Project's main checkout it works the Frontier, up to --parallel
// Tickets side by side (two without it, never more than the Contract's
// `parallel` cap), lowest number first, with no guess at
// which files a Ticket will touch (ADR 0008): it claims each Ticket, gives it a
// worktree under .claude/worktrees/, and has a headless Claude Code session
// (src/claude.ts) implement it with the implementing prompt (prompts/) on the
// Ticket's Tier, told which other Tickets are in flight. Then it routes on the
// session's structured report: a branch with no recorded review goes back to
// the same session to review it; one touching a Surface goes to a Verifier
// session; a finished one goes to `verkstad land`; what cannot finish is Parked
// with `verkstad land --park`. The Tickets' sessions run at the same time, but
// their Landings run one at a time, in this process and under Landing's lock, a
// later one rebasing onto what an earlier one landed; while one runs, the Run
// reads no ask. When a Ticket is
// closed or Parked it reads the Frontier again, so a Landing that unblocks a
// Ticket starts it next, and stops when nothing is ready or in flight, or after
// --max Tickets. A landed Ticket that adds a Surface the Contract lacks makes it
// file a Ticket to declare the Surface and teach the Verify skill to drive it,
// which it works next; in a Project with no Verify skill yet it stops instead.
//
// Every routing rule and every budget is here, in code (docs/contract.md lists
// them): a Ticket gets one Resume, one Fix round and one finished conflict, a
// session that ends without a report is resumed once to give one, and a
// Verifier that records nothing runs once more. A Tier comes from the Ticket's
// `tier:light` or `tier:hard` label, standard without one, and a partial
// report goes one Tier up. A session is bounded by its dollar budget, which it
// is told and sees shrink; its turns and its time are only fuses (LIMITS).
// What needs the owner and is not a Park (a session that failed outright, a
// Landing that cannot run) stops the Run, the Ticket still claimed, once the
// other Tickets in flight have finished.
//
// It keeps only what a later step reads: the hand-off files `land` takes go in
// a temporary directory the Run deletes, what a Ticket's agents found goes on
// the Ticket with its report, and the log directory gets one line per step in
// run-<time>.jsonl, besides the Verdicts, reviews and Gate logs the CLI keeps.
//
// Its summary ends with what the Run gave verkstad:reflect to learn from, per
// Ticket: a Park, a failed Landing, a session wrapped up or read from its
// branch, a Resume, a Fix round, a Verifier rerun, a session with more than
// FAILED_CALLS failed tool calls in its transcript, or a stop; or that it was clean.
//
// `verkstad run --stop` and `--abort` ask the Run going in the Project to end, by
// appending `{"asked": …}` to its event log, which the Run reads before each
// Ticket and each step, and every second while a session runs. On a stop it
// finishes every Ticket in flight and claims no other. On an abort it kills the
// sessions working the Tickets with everything they started, never a Landing,
// and discards each such Ticket's work: its worktree, its branch here and on
// origin and its review record; the Ticket goes back on the Frontier, unassigned.

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { session, type SessionOptions, type SessionResult, stoppedAtLimit } from "./claude.ts";
import { readContract, readParallel, readSurfaces, readVerify, type Surface } from "./contract.ts";
import { Failure } from "./fail.ts";
import { type Entry, readFrontier } from "./frontier.ts";
import { currentRepo, gh, ghJson, ghJsonUnlessMissing } from "./gh.ts";
import { ensureLogDirectory, git, inLinkedWorktree, logDirectory, tryGit, worktreeRoot } from "./git.ts";
import {
  CONFLICT_SCHEMA,
  conflictPrompt,
  IMPLEMENT_SCHEMA,
  implementPrompt,
  pluginRoot,
  readAgent,
  VERIFY_SCHEMA,
  verifyPrompt,
} from "./prompts.ts";
import { deleteReview, missingReview, reviewPath } from "./review.ts";
import { branchPoint, touchedSurfaces } from "./surfaces.ts";
import { failedToolCalls, readJsonLines, sessionDirs } from "./transcripts.ts";
import { checkVerdict, type Verdict } from "./verdict.ts";

const USAGE = "usage: verkstad run [--max <n>] [--parallel <n>] [--budget <usd>] [--dry-run] | verkstad run --stop | verkstad run --abort";

/** What the owner may ask of the Run going: to stop after its Ticket, or to abort it now. */
type Ask = "stop" | "abort";

/** The comment an aborted Ticket gets. */
const ABORTED = "Aborted by the owner during a Run; its work was discarded and the next Run starts it afresh.";

/** How often, in milliseconds, the Run reads its event log for an abort while a session runs. */
const ASK_POLL_MS = 1000;

/** Thrown up to the Run when the owner aborts it: not a Failure, since nothing failed. */
class Aborted extends Error {}

const TIERS = ["light", "standard", "hard"] as const;
type Tier = (typeof TIERS)[number];

/**
 * What a session may spend, in USD, how many turns it may take, and how long it may run. The budget is the
 * bound: Claude Code shows the session what is left, and the prompt tells it to wrap up near the end. The
 * turns and the hours are fuses, set well above what a session needs, for one that loops or hangs.
 */
interface Limits {
  usd: number;
  turns: number;
  hours: number;
}

/** By agent; from the cost and turns of the Tier agents' past sessions, about twice the most one took. */
const LIMITS: Record<string, Limits> = {
  "ticket-light": { usd: 5, turns: 200, hours: 1 },
  "ticket-standard": { usd: 25, turns: 250, hours: 2 },
  "ticket-hard": { usd: 35, turns: 400, hours: 3 },
  verifier: { usd: 10, turns: 120, hours: 1 },
};

/**
 * A session resumed once to report after it ended without one gets a budget of its own: few turns, but enough
 * to reload a large context, whose first turn alone can cost several dollars.
 */
const WRAP_UP: Limits = { usd: 10, turns: 15, hours: 0.5 };

/**
 * Failed tool calls a session may have before the summary names it for reflect: a Ticket worked test-first
 * fails some commands on purpose, so only a session well past that is worth reading.
 */
const FAILED_CALLS = 20;

/** Steps one Ticket may take before the Run gives up on it: far more than every budget allows. */
const MAX_STEPS = 30;

const WRAP_UP_IMPLEMENTER =
  "Your session hit its limit. Do no new work. Commit what passes as it stands, leave the worktree clean, and " +
  "give the report as your structured output: status partial unless every criterion is met, saying exactly what is left.";
const WRAP_UP_VERIFIER =
  "Your session hit its limit. Walk nothing more: record the Verdict now from what you have seen, stop what you " +
  "started, and give the report as your structured output.";

/** What a session is told about its budget, by what it does: build (implement, finish a conflict) or Walk. */
function budgetNote(usd: number, walks: boolean): string {
  const told = `This session has a budget of ${usdText(usd)}, and system reminders show what is left. Do not stop early to save it.`;
  if (walks) return `${told} When about 15% is left, Walk nothing more: record the Verdict from what you have seen, stop what you started, and report.`;
  return (
    `${told} When about 15% is left, start no new work: commit what passes, leave the worktree clean, and report partial, ` +
    "saying exactly what is left. Commit each time `verkstad gate --quick` passes, so that a stop loses little."
  );
}

/** How many Tickets a Run works at once without --parallel, unless the Contract caps it lower. */
const DEFAULT_PARALLEL = 2;

interface Options {
  max: number | null;
  /** The most Tickets the Run works at once, from --parallel; null for the default. */
  parallel: number | null;
  budget: number | undefined;
  dryRun: boolean;
}

function parseArgs(args: string[]): Options {
  const options: Options = { max: null, parallel: null, budget: undefined, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--max" || arg === "--parallel" || arg === "--budget") {
      const value = args[++i];
      const number = Number(value);
      const whole = arg !== "--budget";
      if (value === undefined || !(number > 0) || (whole && !Number.isInteger(number))) {
        throw new Failure(`${arg} needs a positive ${whole ? "whole number" : "amount in USD"}; ${USAGE}`, 2);
      }
      if (arg === "--max") options.max = number;
      else if (arg === "--parallel") options.parallel = number;
      else options.budget = number;
    } else {
      throw new Failure(`unknown argument '${arg}'; ${USAGE}`, 2);
    }
  }
  return options;
}

/** One Run: the Project it works in and what it has spent. */
interface Run {
  main: string;
  base: string;
  /** `origin/<base>`. */
  upstream: string;
  /** owner/name. */
  repo: string;
  logDir: string;
  surfaces: Surface[];
  verify: string | null;
  /** The most Tickets it works at once: --parallel's, or the default capped by the Contract's `parallel`. */
  parallel: number;
  /** The budget every session gets instead of its agent's, from --budget. */
  budget: number | undefined;
  /** The Run's event log, run-<time>.jsonl in the log directory. */
  events: string;
  /** Where the files `verkstad land` takes are written; deleted when the Run ends. */
  handoff: string;
  sessions: number;
  cost: number;
  /** What each Ticket gave reflect to learn from, in the order it happened. */
  forReflect: Map<number, string[]>;
  /** The Tickets the Run is working, by number, with their titles, until each lands, is Parked or ends the Run. */
  inFlight: Map<number, string>;
}

/** Checks the main checkout is one a Run may start from, and brings it level with origin. */
function prepare(options: Options): Omit<Run, "repo" | "events" | "handoff" | "forReflect" | "inFlight"> {
  const main = worktreeRoot(process.cwd());
  if (inLinkedWorktree(main)) throw new Failure(`${main} is a worktree; run from the Project's main checkout`);
  const base = readContract(main).baseBranch;
  const cap = readParallel(main);
  if (options.parallel !== null && cap !== null && options.parallel > cap) {
    throw new Failure(`--parallel ${options.parallel} is above this Project's cap of ${cap} (\`parallel\` in .claude/harness.json)`, 2);
  }
  const parallel = options.parallel ?? Math.min(DEFAULT_PARALLEL, cap ?? Infinity);
  const surfaces = readSurfaces(main);
  const verify = readVerify(main);
  if (surfaces.length && verify === null) {
    throw new Failure("the Contract declares Surfaces but names no Verify skill in `verify`; run /verkstad:create-verify");
  }
  const current = git(main, ["branch", "--show-current"]).trim();
  if (current !== base) throw new Failure(`the main checkout is on ${current ? `branch ${current}` : "a detached HEAD"}, not ${base}`);
  if (git(main, ["status", "--porcelain", "--untracked-files=no"]).trim()) {
    throw new Failure("the main checkout has uncommitted changes; commit or stash them first");
  }
  for (const dir of [".claude/verkstad/", ".claude/worktrees/"]) {
    if (tryGit(main, ["check-ignore", "-q", dir]).status !== 0) throw new Failure(`${dir} is not gitignored; add it to the Project's .gitignore`);
  }
  const upstream = `origin/${base}`;
  git(main, ["fetch", "--quiet", "origin", base]);
  if (tryGit(main, ["merge-base", "--is-ancestor", "HEAD", upstream]).status !== 0) {
    throw new Failure(`${base} has commits ${upstream} lacks; push them or drop them first`);
  }
  git(main, ["merge", "--quiet", "--ff-only", upstream]);
  return { main, base, upstream, logDir: ensureLogDirectory(main), surfaces, verify, parallel, budget: options.budget, sessions: 0, cost: 0 };
}

function log(run: Run, event: Record<string, unknown>): void {
  appendFileSync(run.events, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
}

/** What the owner has asked of the Run in its event log: an abort over a stop, or nothing. */
function asked(events: Array<Record<string, unknown>>): Ask | null {
  if (events.some((e) => e.asked === "abort")) return "abort";
  return events.some((e) => e.asked === "stop") ? "stop" : null;
}

function askedOf(run: Run): Ask | null {
  return asked(readJsonLines(run.events));
}

/** Ends the Run here when the owner has asked to abort it. */
function abortIfAsked(run: Run): void {
  if (askedOf(run) === "abort") throw new Aborted();
}

/** Notes something Ticket #n gave reflect to learn from, once. */
function forReflect(run: Run, n: number, what: string): void {
  const noted = run.forReflect.get(n) ?? [];
  if (!noted.includes(what)) noted.push(what);
  run.forReflect.set(n, noted);
}

/** The summary's last line: what the Run gave reflect to learn from, per Ticket, or that it was clean. */
function reflectLine(run: Run): string {
  if (run.forReflect.size === 0) {
    return (
      "The Run was clean: no Park, failed Landing, wrap-up, Resume, Fix round, Verifier rerun or session with more than " +
      `${FAILED_CALLS} failed tool calls.`
    );
  }
  const tickets = [...run.forReflect].map(([n, noted]) => `#${n} ${noted.join(", ")}`);
  return `Something for /verkstad:reflect to learn from: ${tickets.join("; ")}.`;
}

/** Notes each of Ticket #n's sessions whose transcript has more than FAILED_CALLS failed tool calls. */
function noteFailedCalls(run: Run, t: Ticket): void {
  const dirs = sessionDirs(run.main);
  for (const [id, role] of t.sessions) {
    const total = failedToolCalls(id, dirs)?.total ?? 0;
    if (total > FAILED_CALLS) forReflect(run, t.n, `${/^[aeiou]/i.test(role) ? "an" : "a"} ${role} session with ${total} failed tool calls`);
  }
}

/** Prints a line about Ticket #n and logs it. */
function say(run: Run, n: number, text: string): void {
  process.stdout.write(`#${n} ${text}\n`);
  log(run, { ticket: n, say: text });
}

function usdText(amount: number): string {
  return `$${amount.toFixed(2).replace(/\.00$/, "")}`;
}

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0];
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs one of verkstad's own subcommands for Ticket t, as the owner would, in the main checkout. */
function verkstad(run: Run, t: Ticket, args: string[]): CliResult {
  const r = spawnSync(join(pluginRoot, "bin", "verkstad"), args, { cwd: run.main, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Failure(`could not run verkstad ${args[0]}: ${r.error.message}`);
  const result = { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
  log(run, { ticket: t.n, verkstad: args, code: result.code, ...(result.code === 0 ? {} : { stderr: result.stderr }) });
  return result;
}

/** What a failed `verkstad land` said, without its `verkstad land:` prefix and its reason line. */
function landingMessage(stderr: string): string {
  return stderr
    .replace(/^verkstad land: /, "")
    .replace(/\nreason: \S+\s*$/, "")
    .trim();
}

/** A Surface an implementer's report says its change added, which no Surface in the Contract covers. */
interface NewSurface {
  name: string;
  globs: string[];
  /** One line on what a user or another system observes. */
  observes: string;
}

/** The implementer's report, as far as the Run routes on it. */
interface Report {
  status: "done" | "blocked" | "partial";
  surfaces: string[];
  newSurfaces: NewSurface[];
  uncertain: string[];
  knownBug: boolean;
  text: string;
}

function toReport(value: Record<string, unknown>): Report {
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
  const newSurfaces = (Array.isArray(value.new_surfaces) ? value.new_surfaces : []).flatMap((s: unknown): NewSurface[] => {
    if (typeof s !== "object" || s === null) return [];
    const { name, globs, observes } = s as Record<string, unknown>;
    if (typeof name !== "string" || !name.trim()) return [];
    return [{ name: name.trim(), globs: strings(globs), observes: typeof observes === "string" ? observes.trim().replace(/\.$/, "") : "" }];
  });
  return {
    status: value.status === "blocked" || value.status === "partial" ? value.status : "done",
    surfaces: strings(value.surfaces),
    newSurfaces,
    uncertain: strings(value.uncertain),
    knownBug: value.known_bug === true,
    text: typeof value.report === "string" ? value.report.trim() : JSON.stringify(value, null, 2),
  };
}

/** One Ticket as the Run works it, with the budgets it has used. */
interface Ticket {
  n: number;
  tier: Tier;
  worktree: string;
  /** The implementer's last session, which a review or a wrap-up resumes. */
  session: string | null;
  report: Report | null;
  /** What the conflict finisher reported, which goes on the Ticket with the implementer's report. */
  conflictReport: string | null;
  /** The Verifier's last report. */
  verifierReport: string;
  /** The criteria lines of the Verdict that sent it to its Fix round. */
  failedVerdict: string | undefined;
  resumed: boolean;
  fixRound: boolean;
  conflictFinished: boolean;
  reviewAsked: boolean;
  verifierRerun: boolean;
  landedAgain: boolean;
  /** Its sessions' ids and roles, a resumed session once. */
  sessions: Map<string, string>;
}

/**
 * How a Ticket ended this Run: the line the summary shows, the Surfaces it landed that the Contract lacks, and
 * whether its Landing waits on the owner to merge its pull request.
 */
interface Outcome {
  line: string;
  newSurfaces: NewSurface[];
  awaitsMerge: boolean;
}

type Step =
  | { to: "implement"; why?: { kind: "resume" | "fix"; reason: string } }
  | { to: "review" }
  | { to: "verify" }
  | { to: "land" }
  | { to: "conflict"; files: string }
  | { to: "park"; why: string }
  | { to: "done"; outcome: Outcome };

function tierOf(labels: string[]): Tier {
  for (const label of labels) {
    const tier = /^tier:(\w+)$/.exec(label)?.[1];
    if (tier && (TIERS as readonly string[]).includes(tier)) return tier as Tier;
  }
  return "standard";
}

function budgetOf(budget: number | undefined, agent: string): number {
  return budget ?? LIMITS[agent].usd;
}

function describeTier(tier: Tier, budget: number | undefined): string {
  const agent = readAgent(`ticket-${tier}`);
  return `${tier} Tier (${agent.model}, ${agent.effort} effort, ${usdText(budgetOf(budget, agent.name))} budget)`;
}

/** What a session does, for the line that names it, and how it is bounded and told so. */
interface Role {
  name: string;
  agent: string;
  walks: boolean;
}

function implementer(t: Ticket): Role {
  return { name: "implementer", agent: `ticket-${t.tier}`, walks: false };
}

const VERIFIER: Role = { name: "Verifier", agent: "verifier", walks: true };
const CONFLICT_FINISHER: Role = { name: "conflict finisher", agent: "ticket-light", walks: false };

/** Starts a session, or resumes one, for `role`, within its limits, counting what it cost. */
async function runSession(run: Run, t: Ticket, role: Role, cwd: string, prompt: string, schema: object, resume?: string): Promise<SessionResult> {
  const limits = LIMITS[role.agent];
  const budget = budgetOf(run.budget, role.agent);
  const options: SessionOptions = {
    cwd,
    prompt: `${prompt.trimEnd()}\n\n${budgetNote(budget, role.walks)}\n`,
    agent: readAgent(role.agent),
    schema,
    resume,
    maxTurns: limits.turns,
    budgetUsd: budget,
    timeoutMs: limits.hours * 3_600_000,
    // The log directory is outside the worktree, and a session with no one to approve a write there could not
    // record a review, a Verdict or its Evidence.
    addDirs: [run.logDir],
  };
  const result = counted(run, t, role, await watched(run, options));
  return wrapUp(run, t, role, result, options);
}

/** Runs a session, killing it when the owner aborts the Run while it runs; ends the Run then. */
async function watched(run: Run, options: SessionOptions): Promise<SessionResult> {
  abortIfAsked(run);
  const abort = new AbortController();
  const poll = setInterval(() => {
    if (askedOf(run) === "abort") abort.abort();
  }, ASK_POLL_MS);
  try {
    return await session({ ...options, signal: abort.signal });
  } finally {
    clearInterval(poll);
  }
}

function counted(run: Run, t: Ticket, role: Role, result: SessionResult): SessionResult {
  run.sessions++;
  run.cost += result.costUsd;
  if (result.sessionId) t.sessions.set(result.sessionId, role.name);
  const status = result.report?.status ?? result.report?.verdict;
  log(run, { ticket: t.n, session: role.name, id: result.sessionId, subtype: result.subtype, cost: result.costUsd, turns: result.turns, status });
  if (result.subtype === "error_aborted") throw new Aborted();
  return result;
}

/**
 * A session that ended without a report, at a limit or on its own, is resumed once, on a small budget of its
 * own, to give one; any other result stands.
 */
async function wrapUp(run: Run, t: Ticket, role: Role, result: SessionResult, options: SessionOptions): Promise<SessionResult> {
  if (result.report || !(stoppedAtLimit(result) || result.subtype === "success")) return result;
  const how: Record<string, string> = {
    error_max_turns: "stopped at its turn limit",
    error_max_budget_usd: "spent its budget",
    error_timeout: "ran out of time",
    success: "ended",
  };
  say(run, t.n, `${role.name} ${how[result.subtype]} without a report; asking it to commit and report.`);
  forReflect(run, t.n, `${role.name} asked to wrap up`);
  const wrapping: SessionOptions = {
    ...options,
    prompt: role.walks ? WRAP_UP_VERIFIER : WRAP_UP_IMPLEMENTER,
    resume: result.sessionId,
    maxTurns: WRAP_UP.turns,
    budgetUsd: WRAP_UP.usd,
    timeoutMs: WRAP_UP.hours * 3_600_000,
  };
  return counted(run, t, role, await watched(run, wrapping));
}

/** Fails the Run on a session that gave no report and did not stop at a limit: something is wrong beyond the Ticket. */
function noReport(t: Ticket, role: string, result: SessionResult): Failure {
  return new Failure(
    `#${t.n}'s ${role} session failed (${result.subtype}) without a report; its session is ${result.sessionId}, in ${t.worktree}. ` +
      `#${t.n} stays claimed.`,
  );
}

/** Whether a session that gave no report even when asked once more ended in a way the Run routes on, rather than failed. */
function endedWithoutFailing(result: SessionResult): boolean {
  return stoppedAtLimit(result) || result.subtype === "success";
}

/** The Ticket's worktree, made afresh from origin's base branch; a leftover one goes first, unless it holds uncommitted work. */
function freshWorktree(run: Run, t: Ticket): string {
  const wt = join(run.main, ".claude", "worktrees", `issue-${t.n}`);
  if (existsSync(wt)) {
    const status = tryGit(wt, ["status", "--porcelain"]);
    if (status.status === 0 && status.stdout.trim()) {
      throw new Failure(`#${t.n}'s worktree ${wt} has uncommitted changes: an agent left work behind; see \`git -C ${wt} status\``);
    }
    tryGit(run.main, ["worktree", "remove", "--force", "--force", wt]);
    if (existsSync(wt)) throw new Failure(`could not remove #${t.n}'s old worktree ${wt}`);
  }
  git(run.main, ["worktree", "prune"]);
  git(run.main, ["fetch", "--quiet", "origin", run.base]);
  git(run.main, ["worktree", "add", "--quiet", "--detach", wt, run.upstream]);
  // Gitignored, so a fresh checkout lacks it; the session's scratch files go here.
  mkdirSync(join(wt, ".claude", "verkstad"), { recursive: true });
  t.worktree = wt;
  return wt;
}

/** Whether Ticket #n has a branch, here or on origin, from an earlier Run or a Park. */
function hasBranch(run: Run, n: number): boolean {
  const ref = `refs/heads/issue-${n}`;
  if (tryGit(run.main, ["show-ref", "--verify", "--quiet", ref]).status === 0) return true;
  return tryGit(run.main, ["ls-remote", "--exit-code", "--heads", "origin", ref]).status === 0;
}

function currentState(run: Run): string {
  return `the last commits on ${run.base} are\n${git(run.main, ["log", "--oneline", "-5", run.upstream]).trim()}`;
}

function specOf(n: number): number | undefined {
  return ghJsonUnlessMissing<{ number: number }>(["api", `repos/{owner}/{repo}/issues/${n}/parent`])?.number;
}

async function runTicket(run: Run, entry: Entry): Promise<Outcome> {
  const n = entry.number;
  const t: Ticket = {
    n,
    tier: tierOf(entry.labels),
    worktree: join(run.main, ".claude", "worktrees", `issue-${n}`),
    session: null,
    report: null,
    conflictReport: null,
    verifierReport: "",
    failedVerdict: undefined,
    resumed: false,
    fixRound: false,
    conflictFinished: false,
    reviewAsked: false,
    verifierRerun: false,
    landedAgain: false,
    sessions: new Map(),
  };
  gh(["issue", "edit", String(n), "--add-assignee", "@me"]);
  say(run, n, `${entry.title}: claimed, ${describeTier(t.tier, run.budget)}.`);
  log(run, { ticket: n, claimed: entry.title, tier: t.tier });
  const step: Step = hasBranch(run, n)
    ? { to: "implement", why: { kind: "resume", reason: `an earlier Run or a Park left the branch issue-${n}; continue it from where it is.` } }
    : { to: "implement" };
  try {
    return await work(run, t, step);
  } finally {
    noteFailedCalls(run, t);
  }
}

/** Takes Ticket t from `first` from step to step until it lands or is Parked. */
async function work(run: Run, t: Ticket, first: Step): Promise<Outcome> {
  let step = first;
  for (let steps = 0; steps < MAX_STEPS; steps++) {
    // A Park decided on goes ahead, as one running would.
    if (step.to !== "done" && step.to !== "park") abortIfAsked(run);
    switch (step.to) {
      case "implement":
        step = await implement(run, t, step.why);
        break;
      case "review":
        step = await review(run, t);
        break;
      case "verify":
        step = await verify(run, t);
        break;
      case "land":
        step = land(run, t);
        break;
      case "conflict":
        step = await finishConflict(run, t, step.files);
        break;
      case "park":
        return park(run, t, step.why);
      case "done":
        return step.outcome;
    }
  }
  throw new Failure(`#${t.n} took ${MAX_STEPS} steps without landing or Parking; it stays claimed`);
}

async function implement(run: Run, t: Ticket, why?: { kind: "resume" | "fix"; reason: string }): Promise<Step> {
  const wt = freshWorktree(run, t);
  say(run, t.n, `implementing in ${relative(run.main, wt)}.`);
  const prompt = implementPrompt({
    n: t.n,
    repo: run.repo,
    base: run.base,
    currentState: currentState(run),
    spec: specOf(t.n),
    resumeReason: why?.kind === "resume" ? why.reason : undefined,
    findings: why?.kind === "fix" ? why.reason : undefined,
    others: [...run.inFlight].filter(([n]) => n !== t.n).map(([n, title]) => ({ n, title })),
  });
  const result = await runSession(run, t, implementer(t), wt, prompt, IMPLEMENT_SCHEMA);
  t.session = result.sessionId;
  return reported(run, t, result);
}

/** Routes on what an implementer session reported. */
function reported(run: Run, t: Ticket, result: SessionResult): Step {
  if (!result.report) {
    if (!endedWithoutFailing(result)) throw noReport(t, "implementing", result);
    return fromGit(run, t);
  }
  const report = toReport(result.report);
  t.report = report;
  say(run, t.n, `implementer reported ${report.status} (${usd(result.costUsd)}).`);
  const uncertain = report.uncertain.join("; ") || "(it named nothing)";
  const theReport = `The implementer's report:\n${report.text}`;
  if (report.status === "blocked") return { to: "park", why: `blocked: ${uncertain}\n\n${theReport}` };
  if (report.status === "partial") {
    return resumeOrPark(run, t, `partial: ${uncertain}`, `Resumed once, and it is partial again: ${uncertain}\n\n${theReport}`, true);
  }
  if (report.knownBug) {
    return resumeOrPark(run, t, `done, with a known bug: ${uncertain}`, `Resumed once, and it is done with a known bug again: ${uncertain}\n\n${theReport}`);
  }
  return { to: "review" };
}

/**
 * An implementer that gave no report, even when asked once more, is not asked again: the branch says what it
 * did. Its commits make it partial; uncommitted work in the worktree is the owner's to look at.
 */
function fromGit(run: Run, t: Ticket): Step {
  if (existsSync(t.worktree) && tryGit(t.worktree, ["status", "--porcelain"]).stdout.trim()) {
    throw new Failure(
      `#${t.n}'s implementer gave no report, even when asked, and left uncommitted work in ${t.worktree}; ` +
        `see \`git -C ${t.worktree} status\`. #${t.n} stays claimed.`,
    );
  }
  const commits = tryGit(run.main, ["log", "--oneline", `${run.upstream}..issue-${t.n}`]);
  const done = commits.status === 0 ? commits.stdout.trim() : "";
  const what = done ? `it gave no report, even when asked; its branch has\n${done}` : "it gave no report, even when asked, and committed nothing";
  say(run, t.n, `implementer gave no report; ${done ? "its commits make it partial" : "it committed nothing"}.`);
  forReflect(run, t.n, "read from its branch");
  return resumeOrPark(run, t, `partial: ${what}`, `Resumed once, and ${what}`, true);
}

/** The Ticket's one Resume, one Tier up when `up`; Parked with `parkWhy` when it had it. */
function resumeOrPark(run: Run, t: Ticket, reason: string, parkWhy: string, up = false): Step {
  if (t.resumed) return { to: "park", why: parkWhy };
  t.resumed = true;
  if (up) t.tier = TIERS[Math.min(TIERS.indexOf(t.tier) + 1, TIERS.length - 1)];
  forReflect(run, t.n, "Resumed");
  say(run, t.n, `Resuming on the ${t.tier} Tier: ${firstLine(reason)}`);
  log(run, { ticket: t.n, resumed: firstLine(reason), tier: t.tier });
  return { to: "implement", why: { kind: "resume", reason } };
}

/** A branch with no recorded review goes back to the implementer's own session, once, to review it. */
async function review(run: Run, t: Ticket): Promise<Step> {
  const branch = `issue-${t.n}`;
  if (missingReview(run.logDir, branch) === null) return { to: "verify" };
  if (t.reviewAsked || t.session === null) {
    return { to: "park", why: `No review of ${branch} is recorded, though the implementer was asked for one.\n\nThe implementer's report:\n${t.report?.text ?? ""}` };
  }
  t.reviewAsked = true;
  say(run, t.n, `no review of ${branch} is recorded; resuming the implementer's session to review it.`);
  const prompt =
    `No review of ${branch} is recorded. Run \`git merge-base HEAD ${run.upstream}\` on its own, review the branch with ` +
    "Skill verkstad:review against the commit it prints, fix the real findings, run `verkstad gate`, commit, leave the " +
    "worktree clean, and give the final report again as your structured output.";
  return reported(run, t, await runSession(run, t, implementer(t), t.worktree, prompt, IMPLEMENT_SCHEMA, t.session));
}

/**
 * The Verifier Walks a branch that touches a Surface, after rebasing it onto origin, so that its Verdict is for
 * the patch Landing pushes. The Surfaces are the branch's Contract's, as Landing reads them, so a Surface the
 * branch declares is Walked too.
 */
async function verify(run: Run, t: Ticket): Promise<Step> {
  if (run.surfaces.length === 0 && readSurfaces(t.worktree).length === 0) {
    say(run, t.n, "touches no Surface; landing.");
    return { to: "land" };
  }
  const rebase = verkstad(run, t, ["conflicts", String(t.n), "--rebase", t.worktree]);
  if (rebase.code === 1 && rebase.stdout.trim()) return { to: "conflict", files: rebase.stdout.trim().split("\n").join(", ") };
  if (rebase.code !== 0) throw new Failure(`#${t.n}: rebasing it before the Verifier failed: ${rebase.stderr.trim()}`);
  const surfaces = readSurfaces(t.worktree);
  const touched = touchedSurfaces(t.worktree, surfaces, branchPoint(t.worktree, run.upstream)).map((s) => s.name);
  const named = (t.report?.surfaces ?? []).filter((name) => surfaces.some((s) => s.name === name));
  const walk = [...new Set([...touched, ...named])];
  if (walk.length === 0) {
    say(run, t.n, "touches no Surface; landing.");
    return { to: "land" };
  }
  const verifySkill = readVerify(t.worktree);
  if (verifySkill === null) {
    return {
      to: "park",
      why: `It touches ${walk.join(", ")}, but the Contract names no Verify skill to Walk it with: the first one is the owner's, through verkstad:create-verify.`,
    };
  }
  say(run, t.n, `touches ${walk.join(", ")}; the Verifier Walks it.`);
  const prompt = verifyPrompt({
    n: t.n,
    repo: run.repo,
    base: run.base,
    logDir: run.logDir,
    worktree: t.worktree,
    verify: verifySkill,
    surfaces: walk,
    findings: t.failedVerdict,
  });
  const result = await runSession(run, t, VERIFIER, t.worktree, prompt, VERIFY_SCHEMA);
  if (!result.report && !endedWithoutFailing(result)) throw noReport(t, "Verifier", result);
  t.verifierReport = typeof result.report?.report === "string" ? result.report.report.trim() : "(no report)";
  // The Verdict holds the criteria the Verifier recorded it from.
  rmSync(join(run.logDir, `criteria-${t.n}.json`), { force: true });
  return routeVerdict(run, t, touched.length > 0, ` (${usd(result.costUsd)})`);
}

function criteriaLines(verdict: Verdict): string {
  return verdict.criteria.map((c) => `${c.criterion}: ${c.seen}`).join("\n");
}

/** Routes on the Verdict recorded for the branch's patch, as the Verifier left it. */
function routeVerdict(run: Run, t: Ticket, touched: boolean, cost: string): Step {
  const { verdict } = checkVerdict(t.worktree, t.n, run.upstream);
  const theReport = `The Verifier's report:\n${t.verifierReport}`;
  if (verdict === null) {
    say(run, t.n, `the Verifier recorded no Verdict for this patch${cost}.`);
    if (t.verifierRerun) return { to: "park", why: `The Verifier recorded no Verdict, twice.\n\n${theReport}` };
    t.verifierRerun = true;
    forReflect(run, t.n, "a Verifier rerun");
    return { to: "verify" };
  }
  say(run, t.n, `Verdict: ${verdict.state}${cost}.`);
  switch (verdict.state) {
    case "live-verified":
      return { to: "land" };
    case "failed":
      if (t.fixRound) return { to: "park", why: `The Verdict is failed after the Fix round.\n\n${theReport}` };
      t.fixRound = true;
      t.failedVerdict = criteriaLines(verdict);
      forReflect(run, t.n, "a Fix round");
      say(run, t.n, `Fix round on the ${t.tier} Tier.`);
      return { to: "implement", why: { kind: "fix", reason: `${t.verifierReport}\nEvidence: ${verdict.evidence}` } };
    case "blocked":
      return { to: "park", why: `The Verifier needs the owner.\n\n${theReport}` };
    case "test-verified":
      if (!touched) return { to: "land" };
      return {
        to: "park",
        why:
          "The Verifier found no criterion it could Walk on a Surface the branch touches: do the Surface's globs match " +
          `too much, or does the Ticket lack a criterion a user can see?\n\n${theReport}`,
      };
  }
}

/** The report Landing posts on the Ticket: the implementer's, and the conflict finisher's when there was one. */
function landingReport(run: Run, t: Ticket): string {
  const file = join(run.handoff, `report-${t.n}.md`);
  const finisher = t.conflictReport ? `\n\nRebasing onto ${run.base} conflicted; the conflict finisher reported:\n${t.conflictReport}` : "";
  writeFileSync(file, `${t.report?.text ?? "(no report)"}${finisher}\n`);
  return file;
}

function land(run: Run, t: Ticket): Step {
  const r = verkstad(run, t, ["land", String(t.n), t.worktree, landingReport(run, t)]);
  if (r.code === 0) {
    const landed = /^Landed #\d+ on \S+ in ([0-9a-f]+)/m.exec(r.stdout);
    const opened = /^(?:Opened|Updated) (\S+) onto/m.exec(r.stdout);
    const line = landed ? `landed on ${run.base} in ${landed[1]}` : opened ? `waits on the owner to merge ${opened[1]}` : "landed";
    say(run, t.n, `${line}.`);
    log(run, { ticket: t.n, landed: line, ...(landed ? { commit: landed[1] } : {}) });
    return { to: "done", outcome: { line, newSurfaces: t.report?.newSurfaces ?? [], awaitsMerge: !landed && opened !== null } };
  }
  const reason = /^reason: (\S+)\s*$/m.exec(r.stderr)?.[1] ?? "unknown";
  const message = landingMessage(r.stderr);
  say(run, t.n, `Landing failed: ${reason}.`);
  forReflect(run, t.n, `Landing failed (${reason})`);
  switch (reason) {
    case "review-missing":
      return { to: "review" };
    case "conflict": {
      const files = /conflicts in (.+?)\.?$/m.exec(message)?.[1] ?? "files Landing names";
      if (!t.conflictFinished) {
        t.conflictFinished = true;
        return { to: "conflict", files };
      }
      // A second conflict is the Ticket's Resume.
      if (t.resumed) return { to: "park", why: `Resumed once, and Landing conflicted again.\n\n${message}` };
      t.resumed = true;
      forReflect(run, t.n, "Resumed");
      return { to: "conflict", files };
    }
    case "gate-failed":
    case "no-commits":
      return resumeOrPark(run, t, `Landing failed (${reason}): ${message}`, `Resumed once, and Landing failed again (${reason}).\n\n${message}`);
    case "push-failed":
      if (t.landedAgain) throw new Failure(`#${t.n} did not land twice (push-failed): ${message}`);
      t.landedAgain = true;
      return { to: "land" };
    case "verdict-missing":
    case "verdict-void":
      return { to: "verify" };
    case "verdict-not-live":
      return routeVerdict(run, t, true, "");
    case "contract-narrowed":
      return {
        to: "park",
        why:
          // Landing's last line says where the branch is before the Park pushes it; the Park says where it is after.
          `Landing refused a branch that narrows the Contract: ${message.replace(/\nBranch \S+ is kept.*$/, "")}\n\n` +
          "Narrowing the Contract's Surfaces or its verify is the owner's, through verkstad:maintain-verify; an implementer may only add to them.",
      };
    case "github-failed": {
      const line = `landed, but updating #${t.n} failed: ${firstLine(message)}`;
      log(run, { ticket: t.n, landed: line });
      return { to: "done", outcome: { line, newSurfaces: t.report?.newSurfaces ?? [], awaitsMerge: false } };
    }
    default:
      throw new Failure(`#${t.n} did not land (${reason}): ${message}`);
  }
}

/** A Landing that conflicted goes to the conflict prompt, on the light Tier, in a fresh worktree. */
async function finishConflict(run: Run, t: Ticket, files: string): Promise<Step> {
  say(run, t.n, `conflicts with ${run.base} in ${files}; finishing it on the light Tier.`);
  const wt = freshWorktree(run, t);
  const branch = `issue-${t.n}`;
  const prompt = conflictPrompt({
    n: t.n,
    repo: run.repo,
    base: run.base,
    commits: git(run.main, ["log", "--oneline", `${run.upstream}..${branch}`]).trim(),
    conflictFiles: files,
    landed: git(run.main, ["log", "--oneline", `${branch}..${run.upstream}`]).trim(),
  });
  const result = await runSession(run, t, CONFLICT_FINISHER, wt, prompt, CONFLICT_SCHEMA);
  if (!result.report) {
    if (!endedWithoutFailing(result)) throw noReport(t, "conflict", result);
    return { to: "park", why: `The conflict in ${files} was not finished: the session gave no report, even when asked.` };
  }
  const text = typeof result.report.report === "string" ? result.report.report.trim() : JSON.stringify(result.report);
  say(run, t.n, `conflict finisher reported ${String(result.report.status)} (${usd(result.costUsd)}).`);
  if (result.report.status !== "done") return { to: "park", why: `The conflict in ${files} needs the owner.\n\n${text}` };
  t.conflictReport = text;
  return { to: "verify" };
}

function park(run: Run, t: Ticket, why: string): Outcome {
  const file = join(run.handoff, `park-${t.n}.md`);
  writeFileSync(file, why.trim() + "\n");
  const r = verkstad(run, t, ["land", "--park", String(t.n), t.worktree, file]);
  if (r.code !== 0) throw new Failure(`#${t.n} could not be Parked: ${landingMessage(r.stderr)}`);
  forReflect(run, t.n, "Parked");
  const line = `parked: ${firstLine(why)}`;
  say(run, t.n, line);
  log(run, { ticket: t.n, parked: why.trim() });
  return { line, newSurfaces: [], awaitsMerge: false };
}

/** The Ticket that declares a Surface #n landed and teaches the Verify skill to drive it, in the Ticket format. */
function surfaceTicket(n: number, spec: number | undefined, surface: NewSurface, blockedBy: boolean): { title: string; body: string } {
  const what = surface.observes ? `: ${surface.observes}` : "";
  const globs = surface.globs.length ? ` with the globs ${surface.globs.map((g) => `\`${g}\``).join(", ")}` : "";
  const body = [
    ...(spec === undefined ? [] : ["## Parent", "", `#${spec}`, ""]),
    "## What to build",
    "",
    `#${n} added a Surface the Contract does not declare${what}. Declare it as the Surface ${surface.name}, with the globs whose ` +
      "changes can alter it, and teach the Project's Verify skill to drive it, so that the Verifier Walks every later Ticket that changes it.",
    "",
    "## Acceptance criteria",
    "",
    `- [ ] The Contract declares the Surface ${surface.name}${globs}`,
    `- [ ] The Verify skill's Feature map has an entry for ${surface.name}, and its driving tool a command for it where one is needed`,
    `- [ ] The Verifier Walks ${surface.name} with the Verify skill as this branch changed it`,
    "",
    "## Blocked by",
    "",
    blockedBy ? `- #${n}` : "None - can start immediately",
    "",
  ].join("\n");
  return { title: `Declare the ${surface.name} Surface and teach the Verify skill to drive it`, body };
}

/**
 * Files the Ticket that declares `surface`, a sub-issue of #n's Spec when it has one, ready for an agent; blocked
 * by #n when #n's pull request waits on the owner, since the Surface is not on the base branch until it merges.
 */
function fileSurfaceTicket(run: Run, n: number, surface: NewSurface, awaitsMerge: boolean): Entry {
  const spec = specOf(n);
  const { title, body } = surfaceTicket(n, spec, surface, awaitsMerge);
  const url = gh(["issue", "create", "--title", title, "--body", body, "--label", "ready-for-agent"]).trim();
  const number = Number(/\/issues\/(\d+)$/.exec(url)?.[1]);
  if (!number) throw new Failure(`gh issue create printed no issue URL: ${url}`);
  if (spec !== undefined) {
    const { id } = ghJson<{ id: number }>(["api", `repos/{owner}/{repo}/issues/${number}`]);
    gh(["api", "--method", "POST", `repos/{owner}/{repo}/issues/${spec}/sub_issues`, "-F", `sub_issue_id=${id}`]);
  }
  if (awaitsMerge) {
    const { id } = ghJson<{ id: number }>(["api", `repos/{owner}/{repo}/issues/${n}`]);
    gh(["api", "--method", "POST", `repos/{owner}/{repo}/issues/${number}/dependencies/blocked_by`, "-F", `issue_id=${id}`]);
  }
  log(run, { ticket: n, filed: number, surface: surface.name, globs: surface.globs });
  return { number, title, labels: ["ready-for-agent"], assignees: [], open_blockers: [] };
}

/** What `--dry-run` prints: the Frontier, and the Tickets the Run would start, `count` at most. */
function plan(ready: Entry[], budget: number | undefined, count: number): string {
  const next = ready.slice(0, count).map((e) => `#${e.number}, on the ${describeTier(tierOf(e.labels), budget)}`);
  return `Ready: ${ready.map((e) => `#${e.number} ${e.title} (${tierOf(e.labels)})`).join(", ")}.\nNext: ${next.join("; ")}.\n`;
}

/** `#7`, `#7 and #9`, `#7, #9 and #11`. */
function ticketList(numbers: number[]): string {
  const named = numbers.map((n) => `#${n}`);
  return named.length < 2 ? named.join("") : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
}

/**
 * Discards aborted Ticket #n's work, so that the next Run starts it afresh: its worktree, its branch here and on
 * origin and its review record, whichever it has; unassigns it, keeping its labels, and says so on it. Returns
 * what it discarded.
 */
function discard(run: Run, n: number): string {
  const branch = `issue-${n}`;
  const discarded: string[] = [];
  const wt = join(run.main, ".claude", "worktrees", branch);
  if (existsSync(wt)) {
    tryGit(run.main, ["worktree", "remove", "--force", "--force", wt]);
    rmSync(wt, { recursive: true, force: true });
    discarded.push(`the worktree ${relative(run.main, wt)}`);
  }
  git(run.main, ["worktree", "prune"]);
  if (tryGit(run.main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0) {
    git(run.main, ["branch", "--delete", "--force", branch]);
    discarded.push(`the branch ${branch}`);
  }
  if (tryGit(run.main, ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`]).status === 0) {
    git(run.main, ["push", "--quiet", "origin", "--delete", branch]);
    discarded.push(`${branch} on origin`);
  }
  if (existsSync(reviewPath(run.logDir, branch))) {
    deleteReview(run.logDir, branch);
    discarded.push("its review record");
  }
  gh(["issue", "edit", String(n), "--remove-assignee", "@me"]);
  gh(["issue", "comment", String(n), "--body", ABORTED]);
  const what = discarded.join(", ") || "nothing: it had no worktree, branch or review record yet";
  log(run, { ticket: n, aborted: what });
  return what;
}

/** Whether an event-log line is a Run's end line. */
function isEndLine(e: Record<string, unknown>): boolean {
  return typeof e.run === "string" && e.run !== "started";
}

/** Whether process `pid` is alive; one we may not signal is. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * `verkstad run --stop|--abort`: asks the Run going in the Project, the one whose event log is the newest, has
 * no end line and whose process is alive, to end, and says what will happen.
 */
function ask(what: Ask): void {
  const dir = logDirectory(process.cwd());
  const newest = existsSync(dir) ? readdirSync(dir).filter((name) => /^run-.*\.jsonl$/.test(name)).sort().pop() : undefined;
  const events = newest ? readJsonLines(join(dir, newest)) : [];
  const pid = events.find((e) => e.run === "started")?.pid;
  if (!newest || events.some(isEndLine) || typeof pid !== "number" || !alive(pid)) {
    throw new Failure("no Run is going", 1);
  }
  const file = join(dir, newest);
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), asked: what }) + "\n");
  // The Run may have ended between the reading and the asking.
  const after = readJsonLines(file);
  const end = after.findIndex(isEndLine);
  if (end !== -1 && end < after.findLastIndex((e) => e.asked === what)) throw new Failure("no Run is going", 1);
  // The Tickets the Run is on: those claimed that have not landed, been Parked or failed since.
  const inFlight = new Set<number>();
  for (const e of events) {
    if (typeof e.ticket !== "number") continue;
    if (typeof e.claimed === "string") inFlight.add(e.ticket);
    if (typeof e.landed === "string" || typeof e.parked === "string" || typeof e.failed === "string") inFlight.delete(e.ticket);
  }
  const abort = asked([...events, { asked: what }]) === "abort";
  const tickets = ticketList([...inFlight]);
  if (inFlight.size === 0) {
    process.stdout.write(abort ? "The Run aborts before it claims another Ticket; it has no work to discard.\n" : "The Run stops before it claims another Ticket.\n");
  } else {
    process.stdout.write(abort ? `The Run aborts ${tickets} and discards ${inFlight.size === 1 ? "its" : "their"} work.\n` : `The Run stops after ${tickets}.\n`);
  }
}

export async function run(args: string[]): Promise<void> {
  if (args.includes("--stop") || args.includes("--abort")) {
    if (args.length !== 1) throw new Failure(USAGE, 2);
    return ask(args[0] === "--stop" ? "stop" : "abort");
  }
  const options = parseArgs(args);
  const prepared = prepare(options);
  const { owner, name } = currentRepo();

  const { ready } = readFrontier();
  if (ready.length === 0) {
    process.stdout.write("Nothing is ready: the Frontier is empty.\n");
    return;
  }
  if (options.dryRun) {
    process.stdout.write(plan(ready, options.budget, Math.min(prepared.parallel, options.max ?? Infinity)));
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const r: Run = {
    ...prepared,
    repo: `${owner}/${name}`,
    events: join(prepared.logDir, `run-${stamp}.jsonl`),
    handoff: mkdtempSync(join(tmpdir(), "verkstad-run-")),
    forReflect: new Map(),
    inFlight: new Map(),
  };
  log(r, { run: "started", pid: process.pid, main: r.main, base: r.base, ready: ready.map((e) => e.number) });

  const finished: Array<{ n: number; line: string }> = [];
  const tried = new Set<number>();
  const failures: Failure[] = [];
  /** The Tickets an abort ended before they landed or were Parked, whose work it discards. */
  const abortedTickets: number[] = [];
  let aborted = false;
  /** Set once the Run claims no more Tickets: on a stop, an abort or a failure, or when it cannot go on. */
  let stopping = false;
  // The Tickets filed to declare a new Surface, which go before the rest of the Frontier.
  const filed: Entry[] = [];
  let frontier = ready;
  const working = new Map<number, Promise<{ entry: Entry; outcome?: Outcome; error?: unknown }>>();
  let unexpected: { error: unknown } | null = null;
  for (;;) {
    const ask = askedOf(r);
    if (ask === "abort") aborted = true;
    if (ask !== null) stopping = true;
    const starting: Entry[] = [];
    while (!stopping && working.size + starting.length < r.parallel && (options.max === null || tried.size < options.max)) {
      const next = filed.shift() ?? frontier.find((e) => !tried.has(e.number));
      if (!next) break;
      tried.add(next.number);
      starting.push(next);
    }
    // Every Ticket is in flight before any implementer is told which others are.
    for (const entry of starting) r.inFlight.set(entry.number, entry.title);
    for (const entry of starting) {
      const ended = runTicket(r, entry).then(
        (outcome) => ({ entry, outcome }),
        (error: unknown) => ({ entry, error }),
      );
      working.set(entry.number, ended);
    }
    if (working.size === 0) break;
    const { entry, outcome, error } = await Promise.race(working.values());
    const n = entry.number;
    working.delete(n);
    r.inFlight.delete(n);
    if (outcome === undefined) {
      // The others in flight finish, as on a stop, or end on the abort too.
      stopping = true;
      if (error instanceof Aborted) {
        aborted = true;
        abortedTickets.push(n);
      } else if (error instanceof Failure) {
        failures.push(error);
        forReflect(r, n, "stopped the Run");
        log(r, { ticket: n, failed: error.message });
      } else unexpected ??= { error };
      continue;
    }
    finished.push({ n, line: outcome.line });
    const named = (s: NewSurface): string => `${s.name}${s.observes ? ` (${s.observes})` : ""}`;
    if (outcome.newSurfaces.length && r.verify === null) {
      say(
        r,
        n,
        `added a Surface the Contract lacks: ${outcome.newSurfaces.map(named).join(", ")}. Stopping: the Project has no Verify skill yet; ` +
          "run /verkstad:setup to declare it, then /verkstad:create-verify.",
      );
      stopping = true;
      continue;
    }
    try {
      for (const surface of outcome.newSurfaces) {
        const filedEntry = fileSurfaceTicket(r, n, surface, outcome.awaitsMerge);
        const when = outcome.awaitsMerge ? `blocked by #${n} until its pull request is merged` : "next";
        say(r, n, `added a Surface the Contract lacks: ${named(surface)}; filed #${filedEntry.number} to declare it, ${when}.`);
        if (!outcome.awaitsMerge) filed.push(filedEntry);
      }
      if (!stopping && (options.max === null || tried.size < options.max)) frontier = readFrontier().ready;
    } catch (error) {
      stopping = true;
      if (!(error instanceof Failure)) unexpected ??= { error };
      else {
        failures.push(error);
        forReflect(r, n, "stopped the Run");
      }
    }
  }
  const discards: string[] = [];
  try {
    for (const n of [...abortedTickets].sort((a, b) => a - b)) {
      try {
        discards.push(`#${n}'s work was discarded: ${discard(r, n)}.`);
      } catch (error) {
        if (!(error instanceof Failure)) throw error;
        failures.push(new Failure(`aborting #${n} failed: ${error.message}`));
      }
    }
  } finally {
    rmSync(r.handoff, { recursive: true, force: true });
  }
  const stopped = failures.length ? new Failure(failures.map((f) => f.message).join("\n")) : null;
  if (unexpected) throw unexpected.error;
  const discarded = discards.join(" ");
  const ending = stopped ? "stopped" : aborted ? "aborted" : "finished";
  const stopAsked = ending === "finished" && askedOf(r) === "stop";
  const request = aborted
    ? `Aborted at the owner's request: ${discarded || "no Ticket was in flight, so nothing was discarded."}\n`
    : stopAsked
      ? "Stopped at the owner's request.\n"
      : "";
  const sessions = `${r.sessions} session${r.sessions === 1 ? "" : "s"}, ${usd(r.cost)}`;
  process.stdout.write(
    `Run ${ending}: ${sessions}.\n` + finished.map((f) => `  #${f.n} ${f.line}\n`).join("") + request + `${reflectLine(r)}\n`,
  );
  log(r, { run: ending, sessions: r.sessions, cost: r.cost, finished, error: stopped?.message, ...(stopAsked ? { asked: "stop" } : {}) });
  if (stopped) throw stopped;
}
