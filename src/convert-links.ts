// `verkstad convert-links`: a one-off for a Project that named parents and
// blockers in issue text. It turns the text of each open issue into GitHub's
// native relations (ADR 0006), which `verkstad frontier` reads:
//
//   - the Spec it names becomes its parent (it becomes a native sub-issue): the
//     first issue reference under a `## Parent` heading, or else on a line
//     starting `Part of #<n>`;
//   - every issue reference under a `## Blocked by` heading becomes a native
//     `blocked_by` link, except on a line saying `None` (`- None (if #5 lands
//     first, …)` names no blocker).
//
// Only open issues are converted; their blockers and parents may be closed, and
// are linked all the same (a closed blocker holds nothing back, and the link
// keeps the history). A link already there is left alone, so a second run adds
// nothing. A reference it cannot resolve (no such issue, a pull request,
// another repo, the issue itself) or an issue that already has another parent
// is reported and skipped, never guessed at or moved.

import { Failure } from "./fail.ts";
import { currentRepo, gh, ghJsonUnlessMissing, graphql } from "./gh.ts";

const USAGE = "verkstad convert-links [--dry-run]";

const QUERY = `query OpenIssueLinks($owner: String!, $name: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, after: $after, states: OPEN, orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        databaseId
        body
        parent { number }
        blockedBy(first: 100) { totalCount nodes { number } }
      }
    }
  }
}`;

interface IssueNode {
  number: number;
  databaseId: number;
  body: string;
  parent: { number: number } | null;
  blockedBy: { totalCount: number; nodes: Array<{ number: number }> };
}

interface Page {
  repository: {
    issues: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: IssueNode[] };
  } | null;
}

/** An issue reference in text: `#12`, or `owner/repo#12` when it names its repo. */
interface Ref {
  repo: string | null;
  number: number;
}

/** A link the text asks for. `parent` makes `child` a sub-issue of it; `blocker` blocks `issue`. */
type Link =
  | { kind: "sub-issue"; issue: number; parent: Ref }
  | { kind: "blocked-by"; issue: number; blocker: Ref };

/** How an issue reference resolved: the issue's database id, or why it can't be linked. */
type Resolution = { id: number } | { unresolved: string };

export function convertLinks(args: string[]): void {
  const dryRun = args.includes("--dry-run");
  const unknown = args.filter((arg) => arg !== "--dry-run");
  if (unknown.length) throw new Failure(`unknown argument '${unknown[0]}'; usage: ${USAGE}`, 2);

  const { owner, name } = currentRepo();
  const repo = `${owner}/${name}`;
  const open = fetchOpen(owner, name);
  const resolved = new Map<number, Resolution>(open.map((i) => [i.number, { id: i.databaseId }]));
  const resolve = (ref: Ref): Resolution => {
    let resolution = resolved.get(ref.number);
    if (!resolution) {
      const issue = ghJsonUnlessMissing<{ id: number; pull_request?: unknown }>(["api", `repos/${repo}/issues/${ref.number}`]);
      resolution = !issue
        ? { unresolved: `${repo} has no issue #${ref.number}` }
        : issue.pull_request
          ? { unresolved: `#${ref.number} is a pull request` }
          : { id: issue.id };
      resolved.set(ref.number, resolution);
    }
    return resolution;
  };

  const counts = { subIssues: 0, blockedBy: 0, already: 0, skipped: 0 };
  for (const issue of open) {
    for (const link of linksIn(issue)) {
      const ref = link.kind === "sub-issue" ? link.parent : link.blocker;
      const line = `#${issue.number} ${link.kind === "sub-issue" ? "sub-issue of" : "blocked by"} ${refName(ref, repo)}`;
      const skip = (reason: string) => {
        counts.skipped++;
        process.stdout.write(`skipped ${line}: ${reason}\n`);
      };
      if (!inRepo(ref, repo)) {
        skip("it is in another repo");
        continue;
      }
      if (ref.number === issue.number) {
        skip(link.kind === "sub-issue" ? "an issue cannot be its own sub-issue" : "an issue cannot block itself");
        continue;
      }
      if (link.kind === "sub-issue" && issue.parent?.number === ref.number) {
        counts.already++;
        continue;
      }
      if (link.kind === "blocked-by" && issue.blockedBy.nodes.some((b) => b.number === ref.number)) {
        counts.already++;
        continue;
      }
      if (link.kind === "sub-issue" && issue.parent) {
        skip(`it is already a sub-issue of #${issue.parent.number}`);
        continue;
      }
      const resolution = resolve(ref);
      if ("unresolved" in resolution) {
        skip(resolution.unresolved);
        continue;
      }
      if (!dryRun) add(repo, issue, link, resolution.id);
      if (link.kind === "sub-issue") counts.subIssues++;
      else counts.blockedBy++;
      process.stdout.write(`${line}\n`);
    }
  }

  const summary =
    `${counts.subIssues} sub-issue ${plural(counts.subIssues, "link")} and ` +
    `${counts.blockedBy} blocked_by ${plural(counts.blockedBy, "link")}; ` +
    `${counts.already} already there, ${counts.skipped} skipped.`;
  process.stdout.write(dryRun ? `Would add ${summary} Nothing changed (--dry-run).\n` : `Added ${summary}\n`);
}

function fetchOpen(owner: string, name: string): IssueNode[] {
  const nodes: IssueNode[] = [];
  let after: string | null = null;
  do {
    const page: Page = graphql<Page>(QUERY, { owner, name, first: 100, after });
    if (!page.repository) throw new Failure(`GitHub has no repository ${owner}/${name}`);
    nodes.push(...page.repository.issues.nodes);
    const { hasNextPage, endCursor } = page.repository.issues.pageInfo;
    if (hasNextPage && !endCursor) throw new Failure("GitHub said there are more issues but gave no cursor to them");
    after = hasNextPage ? endCursor : null;
  } while (after);
  for (const node of nodes) {
    if (node.blockedBy.totalCount > node.blockedBy.nodes.length) {
      throw new Failure(`#${node.number} has ${node.blockedBy.totalCount} blockers, more than one query reads`);
    }
  }
  return nodes.sort((a, b) => a.number - b.number);
}

/** The links an issue's text asks for: its parent first, then its blockers in the order named. */
function linksIn(issue: IssueNode): Link[] {
  const lines = issue.body.split(/\r?\n/);
  const links: Link[] = [];
  const parentSection = section(lines, "Parent");
  const parent =
    parentSection !== null
      ? refsIn(parentSection.join("\n"))[0]
      : refsIn(lines.find((line) => /^\s*Part of\s+([\w.-]+\/[\w.-]+)?#\d+/i.test(line)) ?? "")[0];
  if (parent) links.push({ kind: "sub-issue", issue: issue.number, parent });

  const seen = new Set<string>();
  for (const line of section(lines, "Blocked by") ?? []) {
    if (/^\s*(?:[-*+]\s+)?None\b/i.test(line)) continue;
    for (const blocker of refsIn(line)) {
      const key = `${blocker.repo ?? ""}#${blocker.number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ kind: "blocked-by", issue: issue.number, blocker });
    }
  }
  return links;
}

/** The lines under a `## <heading>` line, up to the next heading of level one or two; null without one. */
function section(lines: string[], heading: string): string[] | null {
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${heading}\\s*$`, "i").test(line.trim()));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,2}\s/.test(line));
  return end < 0 ? rest : rest.slice(0, end);
}

function refsIn(text: string): Ref[] {
  return [...text.matchAll(/(?<![\w&/#])(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/g)].map((m) => ({
    repo: m[1] ?? null,
    number: Number(m[2]),
  }));
}

function inRepo(ref: Ref, repo: string): boolean {
  return ref.repo === null || ref.repo.toLowerCase() === repo.toLowerCase();
}

function refName(ref: Ref, repo: string): string {
  return inRepo(ref, repo) ? `#${ref.number}` : `${ref.repo}#${ref.number}`;
}

function add(repo: string, issue: IssueNode, link: Link, id: number): void {
  const [endpoint, field, what] =
    link.kind === "sub-issue"
      ? [`repos/${repo}/issues/${link.parent.number}/sub_issues`, `sub_issue_id=${issue.databaseId}`, `adding #${issue.number} as a sub-issue of #${link.parent.number}`]
      : [`repos/${repo}/issues/${issue.number}/dependencies/blocked_by`, `issue_id=${id}`, `marking #${issue.number} blocked by #${link.blocker.number}`];
  try {
    gh(["api", endpoint, "-X", "POST", "-F", field]);
  } catch (error) {
    if (error instanceof Failure) throw new Failure(`${what}: ${error.message}`);
    throw error;
  }
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}
