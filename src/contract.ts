// The Project's Contract for the scripts: `.claude/harness.json`, read and
// checked here. Only the fields the CLI reads so far are checked (baseBranch,
// gate and landing), each by its reader; a malformed one fails naming the field
// (docs/contract.md describes them all).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Failure } from "./fail.ts";

export const CONTRACT_PATH = ".claude/harness.json";

/**
 * How `gate --quick` narrows a step: to the changed files matching the `files` pathspec, passed in the
 * `env` variable; or not at all when a changed file matches one of `fullWhen`.
 */
export interface Quick {
  files: string;
  env: string;
  fullWhen: string[];
}

export interface GateStep {
  name: string;
  command: string;
  /** A path, relative to the worktree root, whose existence skips the step. */
  unlessExists?: string;
  quick?: Quick;
}

export interface Gate {
  /** Variables set for every step; a value's `$NAME` and `${NAME}` are expanded, null unsets. */
  env: Record<string, string | null>;
  steps: GateStep[];
}

export interface Contract {
  baseBranch: string;
  gate: Gate;
}

type JsonObject = Record<string, unknown>;

function malformed(problem: string): Failure {
  return new Failure(`${CONTRACT_PATH}: ${problem}`);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") throw malformed(`${where} must be a non-empty string`);
  return value;
}

function onlyKnownFields(value: JsonObject, where: string, known: string[]): void {
  const unknown = Object.keys(value).find((key) => !known.includes(key));
  if (unknown !== undefined) {
    throw malformed(`${where} has an unknown field '${unknown}' (known: ${known.join(", ")})`);
  }
}

/** An environment variable's name, as a regex source. */
export const VARIABLE = "[A-Za-z_][A-Za-z0-9_]*";
const VARIABLE_NAME = new RegExp(`^${VARIABLE}$`);

function parseQuick(value: unknown, where: string): Quick {
  if (!isObject(value)) throw malformed(`${where} must be an object`);
  onlyKnownFields(value, where, ["files", "env", "fullWhen"]);
  const files = nonEmptyString(value.files, `${where}.files`);
  if (typeof value.env !== "string" || !VARIABLE_NAME.test(value.env)) {
    throw malformed(`${where}.env must be an environment variable name`);
  }
  const fullWhen = value.fullWhen ?? [];
  if (!Array.isArray(fullWhen)) throw malformed(`${where}.fullWhen must be an array of pathspecs`);
  fullWhen.forEach((glob, i) => nonEmptyString(glob, `${where}.fullWhen[${i}]`));
  return { files, env: value.env, fullWhen: fullWhen as string[] };
}

function parseStep(value: unknown, where: string): GateStep {
  if (!isObject(value)) throw malformed(`${where} must be an object`);
  onlyKnownFields(value, where, ["name", "command", "unlessExists", "quick"]);
  const result: GateStep = {
    name: nonEmptyString(value.name, `${where}.name`),
    command: nonEmptyString(value.command, `${where}.command`),
  };
  if (value.unlessExists !== undefined) {
    result.unlessExists = nonEmptyString(value.unlessExists, `${where}.unlessExists`);
  }
  if (value.quick !== undefined) result.quick = parseQuick(value.quick, `${where}.quick`);
  return result;
}

function parseGate(value: unknown): Gate {
  if (!isObject(value)) throw malformed("gate must be an object");
  onlyKnownFields(value, "gate", ["env", "steps"]);
  const env: Record<string, string | null> = {};
  if (value.env !== undefined) {
    if (!isObject(value.env)) throw malformed("gate.env must be an object");
    for (const [name, v] of Object.entries(value.env)) {
      if (!VARIABLE_NAME.test(name)) throw malformed(`gate.env has '${name}', which is not an environment variable name`);
      if (typeof v !== "string" && v !== null) throw malformed(`gate.env.${name} must be a string or null`);
      env[name] = v;
    }
  }
  if (!Array.isArray(value.steps) || value.steps.length === 0) throw malformed("gate.steps must be a non-empty array");
  const steps = value.steps.map((s, i) => parseStep(s, `gate.steps[${i}]`));
  steps.forEach((s, i) => {
    const first = steps.findIndex((other) => other.name === s.name);
    if (first !== i) throw malformed(`gate.steps[${i}].name '${s.name}' is already the name of gate.steps[${first}]`);
  });
  return { env, steps };
}

/** How Landing puts a Ticket on the base branch. */
export type LandingMode = "push" | "pull-request";

/** Reads and checks the Contract at the root of a checkout or worktree. */
export function readContract(root: string): Contract {
  const value = readJson(root);
  return {
    baseBranch: nonEmptyString(value.baseBranch, "baseBranch"),
    gate: parseGate(value.gate),
  };
}

/** The Contract's `landing`, `push` when it has none. Only `land` reads it, so only `land` checks it. */
export function readLandingMode(root: string): LandingMode {
  const { landing } = readJson(root);
  if (landing === undefined) return "push";
  if (landing !== "push" && landing !== "pull-request") throw malformed(`landing must be "push" or "pull-request"`);
  return landing;
}

function readJson(root: string): JsonObject {
  const path = join(root, CONTRACT_PATH);
  if (!existsSync(path)) throw new Failure(`no Contract: ${path} does not exist`);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Failure(`${CONTRACT_PATH} is not valid JSON: ${(error as Error).message}`);
  }
  if (!isObject(value)) throw malformed("the Contract must be a JSON object");
  return value;
}
