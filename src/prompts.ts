// What a Run's sessions are told: the plugin's agents (agents/<name>.md, whose
// frontmatter fixes model and effort and whose body is the system prompt) and
// the prompt templates (prompts/*-prompt.md, the first fenced block of each),
// filled in here. A template line whose placeholder gets no value is an optional line and
// is dropped; a placeholder left over after filling means the template changed
// under the code, and fails.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Agent } from "./claude.ts";
import { Failure } from "./fail.ts";

/** The plugin's root: the directory holding agents/, prompts/, skills/ and bin/. */
export const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Reads `agents/<name>.md`: its frontmatter's model, effort and disallowedTools, and its body. */
export function readAgent(name: string): Agent {
  const path = join(pluginRoot, "agents", `${name}.md`);
  const text = readFileSync(path, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Failure(`${path} has no frontmatter`);
  const fields = new Map<string, string>();
  for (const line of match[1].split("\n")) {
    const field = /^(\w+):\s*(.*)$/.exec(line);
    if (field) fields.set(field[1], field[2].trim());
  }
  const need = (key: string): string => {
    const value = fields.get(key);
    if (!value) throw new Failure(`${path} sets no ${key}`);
    return value;
  };
  const disallowed = fields.get("disallowedTools");
  return {
    name,
    model: need("model"),
    effort: need("effort"),
    body: match[2].trim(),
    disallowedTools: disallowed ? disallowed.split(",").map((tool) => tool.trim()).filter(Boolean) : [],
  };
}

/** The first fenced block of `prompts/<file>`. */
function template(file: string): string {
  const path = join(pluginRoot, "prompts", file);
  const block = /^```\n([\s\S]*?)\n```$/m.exec(readFileSync(path, "utf8"));
  if (!block) throw new Failure(`${path} has no prompt block`);
  return block[1];
}

/**
 * Fills `{KEY}` placeholders from `values`. A line holding a placeholder whose value is undefined is dropped
 * with it; an empty value disappears, with the space before it. A placeholder `values` lacks fails.
 */
export function fill(text: string, values: Record<string, string | undefined>): string {
  const dropped = Object.keys(values).filter((key) => values[key] === undefined);
  const kept = text.split("\n").filter((line) => !dropped.some((key) => line.includes(`{${key}}`)));
  for (const [token, key] of kept.join("\n").matchAll(/\{([A-Z_]+)\}/g)) {
    if (!(key in values)) throw new Failure(`a prompt template has a placeholder the Run does not fill: ${token}`);
  }
  // One pass, so that a value holding something like a placeholder is never filled in turn.
  const filled = kept.join("\n").replace(/( ?)\{([A-Z_]+)\}/g, (_, space: string, key: string) => {
    const value = values[key] as string;
    return value === "" ? "" : space + value;
  });
  return filled.replace(/\n{3,}/g, "\n\n");
}

/** The paragraph every Run prompt ends with: the final report goes in the structured output. */
const STRUCTURED =
  "Give the final report as your structured output: each field of its schema, with `report` holding the whole report in the format above.";

export interface ImplementValues {
  n: number;
  repo: string;
  base: string;
  currentState: string;
  spec?: number;
  /** Why a Resume came back; set for a Resume only. */
  resumeReason?: string;
  /** The Verifier's findings; set for a Fix round only. */
  findings?: string;
  /** The other Tickets in flight in the Run, by number and title. */
  others: Array<{ n: number; title: string }>;
}

export function implementPrompt(v: ImplementValues): string {
  const body = fill(template("implement-prompt.md"), {
    N: String(v.n),
    REPO: v.repo,
    BASE: v.base,
    CURRENT_STATE: v.currentState,
    SPEC: v.spec === undefined ? undefined : String(v.spec),
    COMMENT: "",
    RESUME_REASON: v.resumeReason,
    FINDINGS: v.findings,
    OTHER_AGENT: v.others.length
      ? "Other agents are implementing these Tickets at the same time, each in a worktree of its own: " +
        `${v.others.map((o) => `#${o.n} ${o.title}`).join("; ")}. Keep out of the code they change; where you cannot, say so in the report.`
      : "",
  });
  return `${body}\n\n${STRUCTURED} Set \`known_bug\` true when Uncertain names a known bug, and \`reviewed\` true only when you ran verkstad:review on the branch's final commits.\n`;
}

export interface VerifyValues {
  n: number;
  repo: string;
  base: string;
  logDir: string;
  worktree: string;
  verify: string;
  surfaces: string[];
  /** The earlier failed Verdict's lines; set after a Fix round only. */
  findings?: string;
}

export function verifyPrompt(v: VerifyValues): string {
  const body = fill(template("verify-prompt.md"), {
    N: String(v.n),
    REPO: v.repo,
    BASE: v.base,
    LOG_DIR: v.logDir,
    WORKTREE: v.worktree,
    VERIFY: v.verify,
    SURFACES: v.surfaces.join(", "),
    COMMENT: "",
    FINDINGS: v.findings,
  });
  return `${body}\n\n${STRUCTURED} \`verdict\` is the Verdict's state, or \`not recorded\`.\n`;
}

export interface ConflictValues {
  n: number;
  repo: string;
  base: string;
  commits: string;
  conflictFiles: string;
  landed: string;
}

export function conflictPrompt(v: ConflictValues): string {
  const body = fill(template("conflict-prompt.md"), {
    N: String(v.n),
    REPO: v.repo,
    BASE: v.base,
    COMMITS: v.commits,
    CONFLICT_FILES: v.conflictFiles,
    LANDED: v.landed,
  });
  return `${body}\n\n${STRUCTURED}\n`;
}

/** The implementer's report, as `implementPrompt` asks for it. */
export const IMPLEMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "worktree", "commits", "what_was_built", "acceptance_criteria", "surfaces", "new_surfaces", "uncertain", "known_bug", "reviewed", "tier", "report"],
  properties: {
    status: { enum: ["done", "blocked", "partial"] },
    worktree: { type: "string" },
    commits: { type: "array", items: { type: "string" } },
    what_was_built: { type: "string" },
    acceptance_criteria: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterion", "verified_by"],
        properties: { criterion: { type: "string" }, verified_by: { type: "string" } },
      },
    },
    surfaces: { type: "array", items: { type: "string" } },
    new_surfaces: {
      type: "array",
      description: "Each new surface the report names, as its name, the path globs whose changes can alter it, and what a user observes; [] for none",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "globs", "observes"],
        properties: {
          name: { type: "string" },
          globs: { type: "array", minItems: 1, items: { type: "string" } },
          observes: { type: "string", description: "One line on what a user or another system observes" },
        },
      },
    },
    uncertain: { type: "array", items: { type: "string" } },
    known_bug: { type: "boolean" },
    reviewed: { type: "boolean" },
    tier: { enum: ["ok", "too low"] },
    report: { type: "string", description: "The whole final report, in the format the prompt gives" },
  },
};

/** The Verifier's report, as `verifyPrompt` asks for it. */
export const VERIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "worktree", "question", "report"],
  properties: {
    verdict: { enum: ["live-verified", "failed", "blocked", "test-verified", "not recorded"] },
    worktree: { type: "string" },
    question: { type: "string", description: "For blocked, the one question for the owner; otherwise none" },
    report: { type: "string", description: "The whole final report, in the format the prompt gives" },
  },
};

/** The conflict finisher's report, as `conflictPrompt` asks for it. */
export const CONFLICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "worktree", "commits", "uncertain", "report"],
  properties: {
    status: { enum: ["done", "blocked"] },
    worktree: { type: "string" },
    commits: { type: "array", items: { type: "string" } },
    uncertain: { type: "array", items: { type: "string" } },
    report: { type: "string", description: "The whole final report, in the format the prompt gives" },
  },
};
