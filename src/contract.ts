// The Project's Contract for the scripts: `.claude/harness.json`, read and
// checked here. Only the fields the CLI reads so far are checked (baseBranch,
// gate, landing, parallel, surfaces and verify), each by its reader; a malformed one fails naming
// the field (docs/contract.md describes them all). Landing also compares a
// branch's Surfaces and verify with its base's, refusing a branch that narrows them.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Failure } from "./fail.ts";
import { tryGit } from "./git.ts";

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

export function isObject(value: unknown): value is JsonObject {
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
  if (!Array.isArray(value.steps)) throw malformed("gate.steps must be an array of steps ([] for a Project with nothing to check yet)");
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

/** The Contract's `baseBranch`, for a command that needs nothing else from it. */
export function readBaseBranch(root: string): string {
  return nonEmptyString(readJson(root).baseBranch, "baseBranch");
}

/** The Contract's `landing`, `push` when it has none. Only `land` reads it, so only `land` checks it. */
export function readLandingMode(root: string): LandingMode {
  const { landing } = readJson(root);
  if (landing === undefined) return "push";
  if (landing !== "push" && landing !== "pull-request") throw malformed(`landing must be "push" or "pull-request"`);
  return landing;
}

/**
 * A Surface: a name, and the globs (git `:(glob)` pathspecs) of the paths whose changes can alter it. A glob
 * starting with `!` takes the paths it matches out of the Surface (its tests, a generated file).
 */
export interface Surface {
  name: string;
  globs: string[];
}

/** The Contract's `surfaces`, required (`[]` for a Project with none) so that no Project lacks them by accident. */
export function readSurfaces(root: string): Surface[] {
  return parseSurfaces(readJson(root));
}

function parseSurfaces({ surfaces }: JsonObject): Surface[] {
  if (!Array.isArray(surfaces)) throw malformed("surfaces must be an array of Surfaces ([] for a Project with none)");
  const result = surfaces.map((value, i): Surface => {
    const where = `surfaces[${i}]`;
    if (!isObject(value)) throw malformed(`${where} must be an object`);
    onlyKnownFields(value, where, ["name", "globs"]);
    const name = nonEmptyString(value.name, `${where}.name`);
    if (!Array.isArray(value.globs) || value.globs.length === 0) throw malformed(`${where}.globs must be a non-empty array of globs`);
    const globs = value.globs.map((glob, j) => {
      const g = nonEmptyString(glob, `${where}.globs[${j}]`);
      const pattern = g.startsWith("!") ? g.slice(1) : g;
      if (pattern === "") throw malformed(`${where}.globs[${j}] '${g}' must be a glob after its !`);
      if (pattern.startsWith(":") || pattern.startsWith("/")) {
        throw malformed(`${where}.globs[${j}] '${g}' must be a glob relative to the Project's root, without pathspec magic`);
      }
      return g;
    });
    if (globs.every((g) => g.startsWith("!"))) throw malformed(`${where}.globs must have a glob that does not start with !`);
    return { name, globs };
  });
  result.forEach((s, i) => {
    const first = result.findIndex((other) => other.name === s.name);
    if (first !== i) throw malformed(`surfaces[${i}].name '${s.name}' is already the name of surfaces[${first}]`);
  });
  return result;
}

/** The Contract's `verify`, the Project's Verify skill, or null when it has none. Only `run` reads it. */
export function readVerify(root: string): string | null {
  return parseVerify(readJson(root));
}

function parseVerify({ verify }: JsonObject): string | null {
  return verify === undefined ? null : nonEmptyString(verify, "verify");
}

/** The Contract's `parallel`, the most Tickets a Run works at once, or null when it caps nothing. Only `run` reads it. */
export function readParallel(root: string): number | null {
  const { parallel } = readJson(root);
  if (parallel === undefined) return null;
  if (typeof parallel !== "number" || !Number.isInteger(parallel) || parallel < 1) throw malformed("parallel must be a whole number of at least 1");
  return parallel;
}

/** What decides which Tickets the Verifier Walks: the Surfaces and the Verify skill. */
export interface Checking {
  surfaces: Surface[];
  verify: string | null;
}

export function readChecking(root: string): Checking {
  return parseChecking(readJson(root));
}

function parseChecking(value: JsonObject): Checking {
  return { surfaces: parseSurfaces(value), verify: parseVerify(value) };
}

/**
 * The Checking of the Contract committed at `rev` in the checkout at `root`, or null when that commit has
 * no Contract, or one whose Surfaces or `verify` are malformed: there is nothing there to narrow.
 */
export function committedChecking(root: string, rev: string): Checking | null {
  const shown = tryGit(root, ["show", `${rev}:${CONTRACT_PATH}`]);
  if (shown.status !== 0) return null;
  try {
    return parseChecking(parseJson(shown.stdout));
  } catch (error) {
    if (error instanceof Failure) return null;
    throw error;
  }
}

/**
 * How `branch` checks less than `base`, one phrase each: a Surface it removes, a glob it removes from one or a
 * `!` glob it adds to one, and `verify` removed or changed. A new Surface, a new glob, a removed `!` glob and
 * a new `verify` only add checking. Surfaces are matched by name, globs by their text.
 */
export function narrowings(base: Checking, branch: Checking): string[] {
  const found: string[] = [];
  for (const surface of base.surfaces) {
    const kept = branch.surfaces.find((s) => s.name === surface.name);
    if (!kept) {
      found.push(`removes the Surface ${surface.name}`);
      continue;
    }
    for (const glob of surface.globs) {
      if (!glob.startsWith("!") && !kept.globs.includes(glob)) found.push(`removes the glob ${glob} from the Surface ${surface.name}`);
    }
    for (const glob of kept.globs) {
      if (glob.startsWith("!") && !surface.globs.includes(glob)) found.push(`adds the glob ${glob} to the Surface ${surface.name}`);
    }
  }
  if (base.verify !== null && branch.verify !== base.verify) {
    found.push(branch.verify === null ? `removes verify (${base.verify})` : `changes verify from ${base.verify} to ${branch.verify}`);
  }
  return found;
}

function readJson(root: string): JsonObject {
  const path = join(root, CONTRACT_PATH);
  if (!existsSync(path)) throw new Failure(`no Contract: ${path} does not exist`);
  return parseJson(readFileSync(path, "utf8"));
}

function parseJson(text: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Failure(`${CONTRACT_PATH} is not valid JSON: ${(error as Error).message}`);
  }
  if (!isObject(value)) throw malformed("the Contract must be a JSON object");
  return value;
}
