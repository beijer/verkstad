// A stub `gh`: a small fake GitHub for tests. It keeps its state (see
// state.ts) in $VERKSTAD_GH_STUB_DIR/state.json, appends every call's argv to
// $VERKSTAD_GH_STUB_DIR/calls.jsonl, and answers exactly the subcommands and
// API requests verkstad makes. Anything else fails loudly, so a new call in the
// CLI needs a handler here before its test can pass.
//
// To support a new call, add one entry:
//   - a subcommand (`gh issue close 7 ...`): to `commands`, keyed "issue close";
//   - a GraphQL operation (`query Frontier(...)`): to `graphql`, keyed by its name;
//   - a REST endpoint (`gh api repos/{owner}/{repo}/...`): to `rest`.
// Handlers read and change `state`; it is written back after every call.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findIssue, subIssues, type StubIssue, type StubState } from "./state.ts";

interface Reply {
  stdout?: string;
  stderr?: string;
  code?: number;
}

type Command = (args: string[], state: StubState) => Reply;
type Variables = Record<string, unknown>;
type GraphqlOperation = (variables: Variables, state: StubState, query: string) => unknown;
interface RestRoute {
  method: string;
  path: RegExp;
  handle: (match: RegExpMatchArray, fields: Variables, state: StubState) => unknown;
}

// --- gh subcommands ---------------------------------------------------------

const commands: Record<string, Command> = {
  "repo view": (args, state) => json(pick({ nameWithOwner: state.repo, name: state.repo.split("/")[1] }, args)),
  api: (args, state) => api(args, state),
};

// --- gh api graphql: operations by name -------------------------------------

const graphql: Record<string, GraphqlOperation> = {
  // Issues, filtered as the query asks (`states: OPEN`, `labels: [$label]`), with
  // their labels, assignees, sub-issue count and blockers.
  Frontier: (v, state, query) => {
    checkRepo(state, v);
    const onlyOpen = /states:\s*OPEN\b/.test(query);
    const onlyLabel = /labels:\s*\[\$label\]/.test(query);
    const matching = state.issues
      .filter((i) => (!onlyOpen || i.state === "open") && (!onlyLabel || i.labels.includes(String(v.label))))
      .sort((a, b) => a.number - b.number);
    const { nodes, pageInfo } = page(matching, v, state);
    return {
      repository: {
        issues: {
          pageInfo,
          nodes: nodes.map((issue) => ({
            number: issue.number,
            title: issue.title,
            labels: { nodes: issue.labels.map((name) => ({ name })) },
            assignees: { nodes: issue.assignees.map((login) => ({ login })) },
            subIssues: { totalCount: subIssues(state, issue.number).length },
            blockedBy: { totalCount: issue.blockedBy.length, nodes: issue.blockedBy.map((n) => issueRef(state, n)) },
          })),
        },
      },
    };
  },
};

// --- gh api <endpoint>: REST routes -----------------------------------------

const rest: RestRoute[] = [];

// --- the rest is plumbing ---------------------------------------------------

function api(args: string[], state: StubState): Reply {
  const { positionals, flags } = parse(args, {
    value: ["-X", "--method", "-f", "--raw-field", "-F", "--field", "-H", "--header", "--input", "-q", "--jq", "-t", "--template"],
  });
  if (flags.has("-q") || flags.has("--jq") || flags.has("-t") || flags.has("--template")) {
    return fail("--jq and --template are not supported: verkstad parses gh's JSON itself");
  }
  const fields: Variables = {};
  for (const raw of [...(flags.get("-f") ?? []), ...(flags.get("--raw-field") ?? [])]) {
    const [key, value] = splitField(raw);
    fields[key] = value;
  }
  for (const typed of [...(flags.get("-F") ?? []), ...(flags.get("--field") ?? [])]) {
    const [key, value] = splitField(typed);
    fields[key] = typedValue(value);
  }
  const endpoint = positionals[0];
  if (endpoint === "graphql") {
    const { query, ...variables } = fields;
    const name = /^\s*(?:query|mutation)\s+(\w+)/.exec(String(query))?.[1];
    const operation = name ? graphql[name] : undefined;
    if (!operation) return fail(`no GraphQL operation ${name ?? "(unnamed)"}`);
    try {
      return json({ data: operation(variables, state, String(query)) });
    } catch (error) {
      return fail(`GraphQL: ${(error as Error).message}`);
    }
  }
  const method = (flags.get("-X") ?? flags.get("--method") ?? [Object.keys(fields).length ? "POST" : "GET"])[0];
  const path = (endpoint ?? "").replace(/^\//, "").replace("{owner}/{repo}", state.repo);
  for (const route of rest) {
    const match = route.method === method ? path.match(route.path) : null;
    if (match) {
      try {
        return json(route.handle(match, fields, state));
      } catch (error) {
        return fail(`HTTP 422: ${(error as Error).message}`);
      }
    }
  }
  return fail(`no REST route for ${method} ${path}`);
}

function issueRef(state: StubState, number: number) {
  const issue = findIssue(state, number);
  if (!issue) throw new Error(`issue #${number} is not in the stub's state`);
  return {
    number: issue.number,
    state: issue.state.toUpperCase(),
    title: issue.title,
    labels: { nodes: issue.labels.map((name) => ({ name })) },
  };
}

function checkRepo(state: StubState, v: Variables): void {
  if (`${v.owner}/${v.name}` !== state.repo) {
    throw new Error(`Could not resolve to a Repository with the name '${v.owner}/${v.name}'.`);
  }
}

/** A connection page honouring `first` and `after`, and the state's pageSize. */
function page(items: StubIssue[], v: Variables, state: StubState) {
  const start = v.after == null ? 0 : Number(v.after);
  const size = Math.min(Number(v.first ?? 100), state.pageSize ?? Infinity);
  const end = start + size;
  return {
    nodes: items.slice(start, end),
    pageInfo: { hasNextPage: end < items.length, endCursor: end < items.length ? String(end) : null },
  };
}

/** `--json a,b` selects fields, as gh does. */
function pick(object: Record<string, unknown>, args: string[]): Record<string, unknown> {
  const fields = parse(args, { value: ["--json", "-q", "--jq", "-R", "--repo"] }).flags.get("--json");
  if (!fields) return object;
  return Object.fromEntries(fields[0].split(",").map((field) => [field, object[field]]));
}

function parse(args: string[], spec: { value: string[] }) {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const [name, inline] = arg.startsWith("--") && eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    const value = inline ?? (spec.value.includes(name) ? args[++i] : "");
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { positionals, flags };
}

function splitField(field: string): [string, string] {
  const eq = field.indexOf("=");
  return [field.slice(0, eq), field.slice(eq + 1)];
}

/** gh's -F conversion: true, false, null and integers become JSON values. */
function typedValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

function json(value: unknown): Reply {
  return { stdout: JSON.stringify(value) + "\n" };
}

function fail(message: string): Reply {
  return { stderr: `stub gh: ${message}\n`, code: 1 };
}

function main(): number {
  const dir = process.env.VERKSTAD_GH_STUB_DIR;
  if (!dir) {
    process.stderr.write("stub gh: VERKSTAD_GH_STUB_DIR is not set; the stub runs only inside a test\n");
    return 1;
  }
  const args = process.argv.slice(2);
  appendFileSync(join(dir, "calls.jsonl"), JSON.stringify(args) + "\n");
  const statePath = join(dir, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8")) as StubState;
  const failure = state.failures?.find((f) => args.join(" ").startsWith(f.command));
  if (failure) {
    process.stderr.write(failure.stderr + "\n");
    return failure.code ?? 1;
  }
  const command = commands[`${args[0]} ${args[1]}`] ?? commands[args[0]];
  const reply: Reply = command
    ? command(commands[`${args[0]} ${args[1]}`] ? args.slice(2) : args.slice(1), state)
    : fail(`no handler for: gh ${args.join(" ")}`);
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  if (reply.stdout) process.stdout.write(reply.stdout);
  if (reply.stderr) process.stderr.write(reply.stderr);
  return reply.code ?? 0;
}

process.exitCode = main();
