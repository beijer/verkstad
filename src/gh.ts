// verkstad's only way to GitHub: the `gh` CLI. It always asks gh for JSON and
// parses it here, never through gh's --jq.
//
// A call GitHub refuses for its rate limit, primary or secondary, fails like any
// other, unless the process has asked to wait rate limits out
// (waitOutRateLimits), as a Run does: then it waits until the limit resets, as
// `gh api rate_limit` reports it, or a minute for a secondary limit, and tries
// the call once more. A second refusal fails.

import { spawnSync } from "node:child_process";
import { Failure } from "./fail.ts";

/** How an error names a gh call: its subcommand, e.g. `gh api graphql`. */
function describe(args: string[]): string {
  return `gh ${args.slice(0, 2).join(" ")}`;
}

export function gh(args: string[]): string {
  const r = run(args);
  if (!r.ok) throw new Failure(`${describe(args)} failed: ${r.stderr}`);
  return r.stdout;
}

export function ghJson<T>(args: string[]): T {
  return parse<T>(args, gh(args));
}

/** Like ghJson, but null when GitHub answers that what was asked for is not there (HTTP 404 or 410). */
export function ghJsonUnlessMissing<T>(args: string[]): T | null {
  const r = run(args);
  if (r.ok) return parse<T>(args, r.stdout);
  if (/\(HTTP (404|410)\)/.test(r.stderr)) return null;
  throw new Failure(`${describe(args)} failed: ${r.stderr}`);
}

/** What gh says of a call GitHub refused for its rate limit, primary or secondary. */
const RATE_LIMITED = /API rate limit (already )?exceeded|secondary rate limit/i;

/** How long to wait out a limit `gh api rate_limit` shows nothing used up for: a secondary one. */
const SECONDARY_WAIT_MS = 60_000;

/** Told, before each wait, until when it waits and which call GitHub refused; null when calls fail at once. */
let waiting: ((until: Date, call: string) => void) | null = null;

/**
 * From now on, a call GitHub refuses for its rate limit waits until the limit resets, then is tried once more;
 * `told` hears of each wait before it starts. The wait blocks the process: everything it does waits on GitHub.
 */
export function waitOutRateLimits(told: (until: Date, call: string) => void): void {
  waiting = told;
}

function run(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = once(args);
  if (r.ok || waiting === null || !RATE_LIMITED.test(r.stderr)) return r;
  const until = resetTime();
  waiting(until, describe(args));
  // A second past the reset, which GitHub gives in whole seconds.
  sleep(until.getTime() + 1000 - Date.now());
  return once(args);
}

/** When the rate limits used up reset, the latest of them, as GitHub reports it; in a minute when it shows none. */
function resetTime(): Date {
  const r = once(["api", "rate_limit"]);
  let resets: number[] = [];
  try {
    const { resources } = JSON.parse(r.stdout) as { resources: Record<string, { remaining: number; reset: number }> };
    resets = Object.values(resources)
      .filter((limit) => limit.remaining === 0)
      .map((limit) => limit.reset * 1000);
  } catch {
    // gh could not say: wait as for a secondary limit.
  }
  return new Date(resets.length ? Math.max(...resets) : Date.now() + SECONDARY_WAIT_MS);
}

function sleep(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function once(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Failure(`could not run gh: ${r.error.message}`);
  return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr.trim() || `exit ${r.status}` };
}

function parse<T>(args: string[], out: string): T {
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new Failure(`${describe(args)} printed something that is not JSON: ${out.slice(0, 200)}`);
  }
}

/** The Project's GitHub repo as owner/name, as gh resolves it from the current directory. */
export function currentRepo(): { owner: string; name: string } {
  const { nameWithOwner } = ghJson<{ nameWithOwner: string }>(["repo", "view", "--json", "nameWithOwner"]);
  const [owner, name] = nameWithOwner.split("/");
  return { owner, name };
}

/** Runs a GraphQL query. Strings go as raw fields, numbers and null as typed ones, a list as one `key[]` field per item. */
export function graphql<T>(query: string, variables: Record<string, string | number | string[] | null>): T {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value === null) continue;
    if (Array.isArray(value)) for (const item of value) args.push("-f", `${key}[]=${item}`);
    else args.push(typeof value === "string" ? "-f" : "-F", `${key}=${value}`);
  }
  const reply = ghJson<{ data?: T; errors?: Array<{ message: string }> }>(args);
  if (reply.errors?.length || !reply.data) {
    throw new Failure(`GitHub GraphQL: ${reply.errors?.map((e) => e.message).join("; ") ?? "no data"}`);
  }
  return reply.data;
}

/** A query whose `repository.issues` is a paginated connection taking `$first` and `$after`. */
interface IssuesPage<N> {
  repository: {
    issues: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: N[] };
  } | null;
}

/** Every node of a query's `repository.issues`, page after page. `variables` carry owner and name. */
export function allIssues<N>(query: string, variables: { owner: string; name: string } & Record<string, string>): N[] {
  const nodes: N[] = [];
  let after: string | null = null;
  do {
    const page: IssuesPage<N> = graphql<IssuesPage<N>>(query, { ...variables, first: 100, after });
    if (!page.repository) throw new Failure(`GitHub has no repository ${variables.owner}/${variables.name}`);
    nodes.push(...page.repository.issues.nodes);
    const { hasNextPage, endCursor } = page.repository.issues.pageInfo;
    if (hasNextPage && !endCursor) throw new Failure("GitHub said there are more issues but gave no cursor to them");
    after = hasNextPage ? endCursor : null;
  } while (after);
  return nodes;
}
