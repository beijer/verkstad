// The fake GitHub the stub `gh` keeps in a JSON file in each test's temp dir.
// Tests seed it through test/project.ts and read it back after running the CLI.

export interface StubComment {
  author: string;
  body: string;
}

export interface StubIssue {
  number: number;
  /** The database id, which REST calls such as adding a sub-issue take instead of the number. */
  id: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  /** Logins. */
  assignees: string[];
  comments: StubComment[];
  /** The issue this one is a native sub-issue of. Its sub-issues are the issues naming it here. */
  parent: number | null;
  /** Native `blocked_by` dependencies: the issues blocking this one. */
  blockedBy: number[];
}

export interface StubPullRequest {
  number: number;
  /** The database id of the pull request's issue; defaults to 2000000 + number. */
  id?: number;
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  head: string;
  base: string;
}

export interface StubLabel {
  name: string;
  description: string;
  /** Six hex digits, no `#`. */
  color: string;
}

export interface StubState {
  /** owner/name, what `gh repo view` reports for the Project. */
  repo: string;
  /** The login gh is signed in as, which `@me` names. */
  viewer: string;
  issues: StubIssue[];
  pullRequests: StubPullRequest[];
  /** The repo's labels, in the order they were created. */
  labels: StubLabel[];
  /** Largest page a paginated GraphQL connection returns, so tests can force several pages. */
  pageSize?: number;
  /** Calls that fail as GitHub would: the first whose `command` prefixes the argv (e.g. "api graphql") wins. */
  failures?: StubFailure[];
  /** GitHub's rate limit, refusing calls until it lets them through. */
  rateLimit?: StubRateLimit;
}

/**
 * A rate limit the stub enforces: it refuses the first `refusals` calls `command` prefixes (every call, without
 * one), except `api rate_limit`, which reports `resource` used up until `reset`.
 */
export interface StubRateLimit {
  command?: string;
  resource: "core" | "graphql";
  /** When GitHub says the limit resets, in seconds since the epoch. */
  reset: number;
  refusals: number;
}

export interface StubFailure {
  command: string;
  stderr: string;
  code?: number;
}

/** The sub-issues of `parent`, in number order. */
export function subIssues(state: StubState, parent: number): StubIssue[] {
  return state.issues.filter((issue) => issue.parent === parent).sort((a, b) => a.number - b.number);
}

export function findIssue(state: StubState, number: number): StubIssue | undefined {
  return state.issues.find((issue) => issue.number === number);
}

/**
 * One headless session the stub `claude` plays (test/stub/claude.ts), in the order the CLI starts or resumes
 * them (per Ticket, when a session names one): the shell commands it runs in its working directory, as an agent would, then the result it prints.
 */
export interface StubSession {
  /** The Ticket whose worktree the session runs in; one left out is played for whichever Ticket calls next. */
  ticket?: number;
  /** Commands run with `sh -c` in the session's working directory, in order; one that fails fails the stub. */
  run?: string[];
  /** The structured output, checked against the call's --json-schema; none when left out. */
  report?: Record<string, unknown>;
  /** The result's subtype: `success` by default, or e.g. `error_max_turns` for a session stopped at its limit. */
  subtype?: string;
  /** What the session cost, in USD; 0.25 by default. */
  cost?: number;
  /** How many of its tool calls failed, as its transcript records them; none by default. */
  failedToolCalls?: number;
}

/** A call the stub `claude` received: its argv, where it ran, and the prompt it read on stdin. */
export interface StubClaudeCall {
  args: string[];
  cwd: string;
  prompt: string;
}
