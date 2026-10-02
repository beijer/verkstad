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
// A GraphQL operation returns every field it can; the stub then keeps only the
// fields the query selects and fails on a field it doesn't know, as GitHub does.

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
  "repo view": (args, state) => {
    const { positionals, flags } = parse(args, { value: ["--json"] });
    if (positionals.length) return fail(`repo view of another repo (${positionals[0]}) is not supported`);
    return json(pick({ nameWithOwner: state.repo, name: state.repo.split("/")[1] }, flags.get("--json")));
  },
  api: (args, state) => api(args, state),
  // Closes an open issue, commenting first when given --comment.
  "issue close": (args, state) => {
    const { positionals, flags } = parse(args, { value: ["--comment"] });
    const issue = issueArg(state, positionals);
    if (issue.state === "closed") return { stderr: `! Issue ${state.repo}#${issue.number} is already closed\n` };
    const comment = flags.get("--comment");
    if (comment) issue.comments.push({ author: state.viewer, body: comment[0] });
    issue.state = "closed";
    return { stderr: `✓ Closed issue ${state.repo}#${issue.number}\n` };
  },
  // Adds and removes labels and removes assignees; `@me` is the viewer.
  "issue edit": (args, state) => {
    const { positionals, flags } = parse(args, {
      value: ["--add-label", "--remove-label", "--remove-assignee"],
    });
    const issue = issueArg(state, positionals);
    const values = (flag: string) =>
      (flags.get(flag) ?? []).flatMap((v) => v.split(",")).map((v) => (v === "@me" ? state.viewer : v));
    const labels = issue.labels.filter((l) => !values("--remove-label").includes(l));
    issue.labels = [...new Set([...labels, ...values("--add-label")])];
    issue.assignees = issue.assignees.filter((a) => !values("--remove-assignee").includes(a));
    return { stdout: `https://github.com/${state.repo}/issues/${issue.number}\n` };
  },
  "issue comment": (args, state) => {
    const { positionals, flags } = parse(args, { value: ["--body"] });
    const issue = issueArg(state, positionals);
    const body = flags.get("--body");
    if (!body) throw new Error("only --body is supported");
    issue.comments.push({ author: state.viewer, body: body[0] });
    return { stdout: `https://github.com/${state.repo}/issues/${issue.number}#issuecomment-1\n` };
  },
};

/** The one issue a subcommand names by number. */
function issueArg(state: StubState, positionals: string[]): StubIssue {
  if (positionals.length !== 1 || !/^\d+$/.test(positionals[0])) {
    throw new Error(`expected one issue number, got ${JSON.stringify(positionals)}`);
  }
  const issue = findIssue(state, Number(positionals[0]));
  if (!issue) throw new Error(`Could not resolve to an issue or pull request with the number of ${positionals[0]}.`);
  return issue;
}

// --- gh api graphql: operations by name -------------------------------------

const graphql: Record<string, GraphqlOperation> = {
  // Issues, filtered as the query asks (`states: OPEN`, `labels: [$label]`), with
  // their labels, assignees, sub-issue count and blockers.
  Frontier: (v, state, query) => issues(v, state, query),
  // Open issues with their bodies and the native links they have: parent and blockers.
  OpenIssueLinks: (v, state, query) => issues(v, state, query),
};

/** A page of the repo's issues, filtered as the query asks, each with every field an operation reads. */
function issues(v: Variables, state: StubState, query: string) {
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
          databaseId: issue.id,
          title: issue.title,
          body: issue.body,
          labels: { nodes: issue.labels.map((name) => ({ name })) },
          assignees: { nodes: issue.assignees.map((login) => ({ login })) },
          parent: issue.parent === null ? null : { number: issue.parent },
          subIssues: { totalCount: subIssues(state, issue.number).length },
          blockedBy: { totalCount: issue.blockedBy.length, nodes: issue.blockedBy.map((n) => issueRef(state, n)) },
        })),
      },
    },
  };
}

// --- gh api <endpoint>: REST routes -----------------------------------------

const rest: RestRoute[] = [
  // An issue, or a pull request's issue (which carries `pull_request`).
  {
    method: "GET",
    path: /^repos\/[^/]+\/[^/]+\/issues\/(\d+)$/,
    handle: ([, number], _fields, state) => restIssue(state, Number(number)),
  },
  // Adds the issue whose database id is `sub_issue_id` as a sub-issue; an issue has one parent at most.
  {
    method: "POST",
    path: /^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/sub_issues$/,
    handle: ([, number], fields, state) => {
      const parent = issueOr404(state, Number(number));
      const child = byId(state, fields.sub_issue_id);
      if (child.parent !== null) throw new Error(`Sub issue may only have one parent (#${child.number} has #${child.parent})`);
      if (child.number === parent.number) throw new Error("An issue cannot be its own sub-issue");
      child.parent = parent.number;
      return restIssue(state, parent.number);
    },
  },
  // Marks the issue as blocked by the issue whose database id is `issue_id`.
  {
    method: "POST",
    path: /^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/dependencies\/blocked_by$/,
    handle: ([, number], fields, state) => {
      const issue = issueOr404(state, Number(number));
      const blocker = byId(state, fields.issue_id);
      if (issue.blockedBy.includes(blocker.number)) throw new Error(`#${issue.number} is already blocked by #${blocker.number}`);
      if (blocker.number === issue.number) throw new Error("An issue cannot block itself");
      issue.blockedBy.push(blocker.number);
      return restIssue(state, issue.number);
    },
  },
];

/** What GitHub answers with a 4xx other than 422, e.g. 404 for an issue that doesn't exist. */
class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function issueOr404(state: StubState, number: number): StubIssue {
  const issue = findIssue(state, number);
  if (!issue) throw new HttpError(404, "Not Found");
  return issue;
}

/** The issue a REST body names by database id; GitHub wants an integer there, as `-F` sends it. */
function byId(state: StubState, id: unknown): StubIssue {
  if (typeof id !== "number") throw new Error(`the issue id must be an integer, not ${JSON.stringify(id)}`);
  const issue = state.issues.find((i) => i.id === id);
  if (!issue) throw new HttpError(404, "Not Found");
  return issue;
}

function restIssue(state: StubState, number: number): Record<string, unknown> {
  const issue = findIssue(state, number);
  if (issue) return { id: issue.id, number, title: issue.title, state: issue.state };
  const pr = state.pullRequests.find((p) => p.number === number);
  if (!pr) throw new HttpError(404, "Not Found");
  return {
    id: pr.id ?? 2_000_000 + number,
    number,
    title: pr.title,
    state: pr.state === "open" ? "open" : "closed",
    pull_request: { url: `https://api.github.com/repos/${state.repo}/pulls/${number}` },
  };
}

// --- the rest is plumbing ---------------------------------------------------

function api(args: string[], state: StubState): Reply {
  const { positionals, flags } = parse(args, {
    value: ["-X", "--method", "-f", "--raw-field", "-F", "--field", "-H", "--header", "--input"],
  });
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
      return json({ data: select(String(query), operation(variables, state, String(query))) });
    } catch (error) {
      return fail(`GraphQL: ${(error as Error).message}`);
    }
  }
  const method = (flags.get("-X") ?? flags.get("--method") ?? [Object.keys(fields).length ? "POST" : "GET"])[0];
  const path = (endpoint ?? "").replace(/^\//, "").replace("{owner}/{repo}", state.repo);
  if (path.startsWith("repos/") && !path.startsWith(`repos/${state.repo}/`)) {
    return { stderr: "gh: Not Found (HTTP 404)\n", code: 1 };
  }
  for (const route of rest) {
    const match = route.method === method ? path.match(route.path) : null;
    if (match) {
      try {
        return json(route.handle(match, fields, state));
      } catch (error) {
        if (error instanceof HttpError) return { stderr: `gh: ${error.message} (HTTP ${error.status})\n`, code: 1 };
        return fail(`HTTP 422: ${(error as Error).message}`);
      }
    }
  }
  return fail(`no REST route for ${method} ${path}`);
}

/** Keeps the fields the query's selection set asks for, failing on any `data` lacks. */
function select(query: string, data: unknown): unknown {
  const tokens = query.match(/[A-Za-z_]\w*|"(?:[^"\\]|\\.)*"|\S/g) ?? [];
  let i = 0;
  const skipArguments = () => {
    if (tokens[i] !== "(") return;
    for (let depth = 0; i < tokens.length; i++) {
      if (tokens[i] === "(") depth++;
      if (tokens[i] === ")" && --depth === 0) break;
    }
    i++;
  };
  type Selection = Map<string, Selection | null>;
  const selection = (): Selection => {
    const fields: Selection = new Map();
    for (i++; tokens[i] !== "}"; ) {
      const name = tokens[i++];
      if (tokens[i] === ":") throw new Error(`aliases are not supported (${name})`);
      skipArguments();
      fields.set(name, tokens[i] === "{" ? selection() : null);
    }
    i++;
    return fields;
  };
  const project = (fields: Selection | null, value: unknown, path: string): unknown => {
    if (Array.isArray(value)) return value.map((item) => project(fields, item, path));
    if (fields === null || value === null || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      [...fields].map(([name, sub]) => {
        if (!(name in object)) throw new Error(`Field '${name}' doesn't exist on ${path}`);
        return [name, project(sub, object[name], `${path}.${name}`)];
      }),
    );
  };
  i = 2; // past `query Name`
  skipArguments();
  return project(selection(), data, "data");
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

/** `--json a,b` selects fields, as gh does; an unknown field fails. */
function pick(object: Record<string, unknown>, json: string[] | undefined): Record<string, unknown> {
  if (!json) throw new Error("only --json output is supported");
  return Object.fromEntries(
    json[0].split(",").map((field) => {
      if (!(field in object)) throw new Error(`Unknown JSON field: "${field}"`);
      return [field, object[field]];
    }),
  );
}

/** Splits argv into positionals and flags. `spec.value` lists the flags taking a value and
 * `spec.boolean` those that don't; any other flag throws, so a call the stub doesn't
 * understand fails rather than being half-answered. */
function parse(args: string[], spec: { value: string[]; boolean?: string[] }) {
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
    const takesValue = spec.value.includes(name);
    if (!takesValue && !spec.boolean?.includes(name)) throw new Error(`unsupported flag ${name}`);
    const value = inline ?? (takesValue ? args[++i] : "");
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

function dispatch(args: string[], state: StubState): Reply {
  if (args.some((arg) => /^(-q|--jq|-t|--template)(=|$)/.test(arg))) {
    return fail("--jq and --template are not supported: verkstad parses gh's JSON itself");
  }
  const [key, rest] = commands[`${args[0]} ${args[1]}`]
    ? [`${args[0]} ${args[1]}`, args.slice(2)]
    : [args[0], args.slice(1)];
  const command = commands[key];
  if (!command) return fail(`no handler for: gh ${args.join(" ")}`);
  try {
    return command(rest, state);
  } catch (error) {
    return fail(`gh ${key}: ${(error as Error).message}`);
  }
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
  const reply = dispatch(args, state);
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  if (reply.stdout) process.stdout.write(reply.stdout);
  if (reply.stderr) process.stderr.write(reply.stderr);
  return reply.code ?? 0;
}

process.exitCode = main();
