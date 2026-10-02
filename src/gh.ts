// verkstad's only way to GitHub: the `gh` CLI. It always asks gh for JSON and
// parses it here, never through gh's --jq.

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

function run(args: string[]): { ok: boolean; stdout: string; stderr: string } {
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

/** Runs a GraphQL query. Strings go as raw fields, numbers and null as typed ones. */
export function graphql<T>(query: string, variables: Record<string, string | number | null>): T {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value === null) continue;
    args.push(typeof value === "string" ? "-f" : "-F", `${key}=${value}`);
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
