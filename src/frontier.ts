// `verkstad frontier`: which Tickets can start now, which are in progress, and
// what the rest wait on, from GitHub's native sub-issue and blocked_by relations.
//
// Of the open issues labelled ready-for-agent:
//   - one with sub-issues is a Spec, never ready (listed as wrongly labelled);
//   - one with an assignee is in progress;
//   - one with an open blocker is waiting on it;
//   - the rest are the Frontier: ready.

import { Failure } from "./fail.ts";
import { allIssues, currentRepo } from "./gh.ts";
import { staleCopyWarning } from "./plugin-copy.ts";

const READY_LABEL = "ready-for-agent";
/** A blocker with one of these labels waits on the owner, not on an agent; the view marks it. */
const OWNER_MARKERS: Array<[label: string, marker: string]> = [
  ["ready-for-human", "[human]"],
  ["needs-info", "[needs-info]"],
];

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

/** A GraphQL connection, as far as the query reads it. */
interface Connection<T> {
  nodes: T[];
}

interface IssueNode {
  number: number;
  title: string;
  labels: Connection<{ name: string }>;
  assignees: Connection<{ login: string }>;
  subIssues: { totalCount: number };
  blockedBy: Connection<{ number: number; state: "OPEN" | "CLOSED"; title: string; labels: Connection<{ name: string }> }> & {
    totalCount: number;
  };
}

interface Blocker {
  number: number;
  title: string;
  labels: string[];
}

/** One labelled issue: a Ticket, or a Spec labelled by mistake. */
interface Entry {
  number: number;
  title: string;
  labels: string[];
  assignees: string[];
  open_blockers: Blocker[];
}

/** The Frontier (`ready`) and the rest of the labelled issues, by what holds each back. */
interface Listing {
  ready: Entry[];
  in_progress: Entry[];
  waiting: Entry[];
  specs_labelled: Entry[];
}

export function frontier(args: string[]): void {
  const json = args.includes("--json");
  const unknown = args.filter((arg) => arg !== "--json");
  if (unknown.length) throw new Failure(`unknown argument '${unknown[0]}'; usage: verkstad frontier [--json]`, 2);

  const stale = staleCopyWarning();
  if (stale) process.stderr.write(`verkstad frontier: ${stale}\n`);
  const result = classify(fetchLabelled(READY_LABEL));
  process.stdout.write(json ? JSON.stringify(result, null, 2) + "\n" : render(result));
}

function fetchLabelled(label: string): IssueNode[] {
  return allIssues<IssueNode>(QUERY, { ...currentRepo(), label });
}

function classify(nodes: IssueNode[]): Listing {
  const result: Listing = { ready: [], in_progress: [], waiting: [], specs_labelled: [] };
  for (const node of [...nodes].sort((a, b) => a.number - b.number)) {
    if (node.blockedBy.totalCount > node.blockedBy.nodes.length) {
      throw new Failure(`#${node.number} has ${node.blockedBy.totalCount} blockers, more than one query reads`);
    }
    const entry: Entry = {
      number: node.number,
      title: node.title,
      labels: node.labels.nodes.map((l) => l.name),
      assignees: node.assignees.nodes.map((a) => a.login),
      open_blockers: node.blockedBy.nodes
        .filter((b) => b.state === "OPEN")
        .sort((a, b) => a.number - b.number)
        .map((b) => ({ number: b.number, title: b.title, labels: b.labels.nodes.map((l) => l.name) })),
    };
    if (node.subIssues.totalCount > 0) result.specs_labelled.push(entry);
    else if (entry.assignees.length > 0) result.in_progress.push(entry);
    else if (entry.open_blockers.length > 0) result.waiting.push(entry);
    else result.ready.push(entry);
  }
  return result;
}

function blockerName(blocker: Blocker): string {
  const marker = OWNER_MARKERS.find(([label]) => blocker.labels.includes(label))?.[1];
  return marker ? `#${blocker.number} ${marker}` : `#${blocker.number}`;
}

function render(f: Listing): string {
  const lines = [
    `Ready (${f.ready.length}):`,
    ...f.ready.map((t) => `  #${t.number} ${t.title}`),
    `In progress (${f.in_progress.length}):`,
    ...f.in_progress.map((t) => `  #${t.number} ${t.title}  (${t.assignees.map((a) => `@${a}`).join(", ")})`),
    `Waiting (${f.waiting.length}):`,
    ...f.waiting.map(
      (t) => `  #${t.number} ${t.title}  <- ${t.open_blockers.map(blockerName).join(", ")}`,
    ),
  ];
  if (f.specs_labelled.length) {
    lines.push(`Specs wrongly labelled ${READY_LABEL}: ${f.specs_labelled.map((t) => `#${t.number}`).join(", ")}`);
  }
  return lines.join("\n") + "\n";
}
