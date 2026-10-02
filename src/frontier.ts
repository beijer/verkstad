// `verkstad frontier`: which Tickets can start now, which are in progress, and
// what the rest wait on, from GitHub's native sub-issue and blocked_by relations.
//
// Of the open issues labelled ready-for-agent:
//   - one with sub-issues is a Spec, never ready (listed as wrongly labelled);
//   - one with an assignee is in progress;
//   - one with an open blocker is waiting on it;
//   - the rest are the Frontier: ready.

import { Failure } from "./fail.ts";
import { currentRepo, graphql } from "./gh.ts";

export const READY_LABEL = "ready-for-agent";

const QUERY = `query Frontier($owner: String!, $name: String!, $label: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, after: $after, states: OPEN, labels: [$label], orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        labels(first: 50) { nodes { name } }
        assignees(first: 20) { nodes { login } }
        subIssues { totalCount }
        blockedBy(first: 50) { totalCount nodes { number state title labels(first: 20) { nodes { name } } } }
      }
    }
  }
}`;

interface Names<T> {
  nodes: T[];
}

interface IssueNode {
  number: number;
  title: string;
  labels: Names<{ name: string }>;
  assignees: Names<{ login: string }>;
  subIssues: { totalCount: number };
  blockedBy: Names<{ number: number; state: "OPEN" | "CLOSED"; title: string; labels: Names<{ name: string }> }> & {
    totalCount: number;
  };
}

interface FrontierPage {
  repository: {
    issues: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: IssueNode[] };
  } | null;
}

export interface Blocker {
  number: number;
  title: string;
  labels: string[];
}

export interface Ticket {
  number: number;
  title: string;
  labels: string[];
  assignees: string[];
  open_blockers: Blocker[];
}

export interface Frontier {
  ready: Ticket[];
  in_progress: Ticket[];
  waiting: Ticket[];
  specs_labelled: Ticket[];
}

export function frontier(args: string[]): void {
  const json = args.includes("--json");
  const unknown = args.filter((arg) => arg !== "--json");
  if (unknown.length) throw new Failure(`unknown argument '${unknown[0]}'; usage: verkstad frontier [--json]`, 2);

  const result = classify(fetchLabelled(READY_LABEL));
  process.stdout.write(json ? JSON.stringify(result, null, 2) + "\n" : render(result));
}

function fetchLabelled(label: string): IssueNode[] {
  const { owner, name } = currentRepo();
  const nodes: IssueNode[] = [];
  let after: string | null = null;
  do {
    const page: FrontierPage = graphql<FrontierPage>(QUERY, { owner, name, label, first: 100, after });
    if (!page.repository) throw new Failure(`GitHub has no repository ${owner}/${name}`);
    nodes.push(...page.repository.issues.nodes);
    after = page.repository.issues.pageInfo.hasNextPage ? page.repository.issues.pageInfo.endCursor : null;
  } while (after);
  return nodes;
}

function classify(nodes: IssueNode[]): Frontier {
  const result: Frontier = { ready: [], in_progress: [], waiting: [], specs_labelled: [] };
  for (const node of [...nodes].sort((a, b) => a.number - b.number)) {
    if (node.blockedBy.totalCount > node.blockedBy.nodes.length) {
      throw new Failure(`#${node.number} has ${node.blockedBy.totalCount} blockers, more than one query reads`);
    }
    const ticket: Ticket = {
      number: node.number,
      title: node.title,
      labels: node.labels.nodes.map((l) => l.name),
      assignees: node.assignees.nodes.map((a) => a.login),
      open_blockers: node.blockedBy.nodes
        .filter((b) => b.state === "OPEN")
        .sort((a, b) => a.number - b.number)
        .map((b) => ({ number: b.number, title: b.title, labels: b.labels.nodes.map((l) => l.name) })),
    };
    if (node.subIssues.totalCount > 0) result.specs_labelled.push(ticket);
    else if (ticket.assignees.length > 0) result.in_progress.push(ticket);
    else if (ticket.open_blockers.length > 0) result.waiting.push(ticket);
    else result.ready.push(ticket);
  }
  return result;
}

/** A blocker that waits on the owner rather than on an agent. */
function owner(blocker: Blocker): string {
  if (blocker.labels.includes("ready-for-human")) return " [human]";
  if (blocker.labels.includes("needs-info")) return " [needs-info]";
  return "";
}

function render(f: Frontier): string {
  const lines = [
    `Ready (${f.ready.length}):`,
    ...f.ready.map((t) => `  #${t.number} ${t.title}`),
    `In progress (${f.in_progress.length}):`,
    ...f.in_progress.map((t) => `  #${t.number} ${t.title}  (${t.assignees.map((a) => `@${a}`).join(", ")})`),
    `Waiting (${f.waiting.length}):`,
    ...f.waiting.map(
      (t) => `  #${t.number} ${t.title}  <- ${t.open_blockers.map((b) => `#${b.number}${owner(b)}`).join(", ")}`,
    ),
  ];
  if (f.specs_labelled.length) {
    lines.push(`Specs wrongly labelled ${READY_LABEL}: ${f.specs_labelled.map((t) => `#${t.number}`).join(", ")}`);
  }
  return lines.join("\n") + "\n";
}
