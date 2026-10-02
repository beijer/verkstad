// verkstad's only way to GitHub: the `gh` CLI. It always asks gh for JSON and
// parses it here, never through gh's --jq.

import { spawnSync } from "node:child_process";
import { Failure } from "./fail.ts";

export function gh(args: string[]): string {
  const r = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Failure(`could not run gh: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Failure(`gh ${args[0]} ${args[1] ?? ""} failed: ${r.stderr.trim() || `exit ${r.status}`}`);
  }
  return r.stdout;
}

export function ghJson<T>(args: string[]): T {
  const out = gh(args);
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new Failure(`gh ${args[0]} ${args[1] ?? ""} printed something that is not JSON: ${out.slice(0, 200)}`);
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
