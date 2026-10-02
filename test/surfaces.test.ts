import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { project, type Project } from "./project.ts";

const SURFACES = [
  { name: "ui", globs: ["src/ui/**", "*.html"] },
  { name: "api", globs: ["src/api/**"] },
  { name: "site", globs: ["site/**"] },
];

function contract(surfaces: unknown): object {
  return { baseBranch: "main", gate: { steps: [{ name: "build", command: "true" }] }, surfaces };
}

/** Commits these files on the checked-out branch; a null content deletes the file. */
function commit(p: Project, files: Record<string, string | null>, message = "A change"): void {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      rmSync(join(p.dir, path));
    } else {
      mkdirSync(dirname(join(p.dir, path)), { recursive: true });
      writeFileSync(join(p.dir, path), content);
    }
  }
  p.git("add", "-A");
  p.git("commit", "--quiet", "-m", message);
}

const BASE_FILES = {
  "index.html": "<html>\n",
  "docs/page.html": "<p>\n",
  "src/ui/panel.ts": "panel\n",
  "src/core/engine.ts": "engine\n",
  "site/index.md": "site\n",
};

test("surfaces prints each touched Surface once, in the Contract's order, ignoring what landed on the base meanwhile", (t) => {
  const p = project(t, { contract: contract(SURFACES), files: BASE_FILES });
  p.git("checkout", "--quiet", "-b", "issue-7");
  commit(p, { "src/api/routes.ts": "routes\n", "src/ui/panel.ts": "panel, changed\n" });
  commit(p, { "src/ui/menu/item.ts": "item\n", "src/core/engine.ts": "engine, changed\n" });
  p.git("checkout", "--quiet", "main");
  commit(p, { "site/index.md": "site, changed on main\n" }, "Landed meanwhile");
  p.git("checkout", "--quiet", "issue-7");

  const r = p.run("surfaces", "main");

  assert.equal(r.stderr, "");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "ui\napi\n");

  const json = p.run("surfaces", "main", "--json");
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), [
    { name: "ui", files: ["src/ui/menu/item.ts", "src/ui/panel.ts"] },
    { name: "api", files: ["src/api/routes.ts"] },
  ]);
});

test("surfaces prints nothing for a branch that touches no Surface, and [] with --json", (t) => {
  const p = project(t, { contract: contract(SURFACES), files: BASE_FILES });
  p.git("checkout", "--quiet", "-b", "issue-7");
  // `*` in a glob stops at `/`: docs/page.html is not `*.html`.
  commit(p, { "src/core/engine.ts": "engine, changed\n", "docs/page.html": "<p>changed\n", "src/uix.ts": "near miss\n" });
  // Uncommitted and untracked changes are not part of the branch.
  writeFileSync(join(p.dir, "src", "ui", "panel.ts"), "edited, not committed\n");
  writeFileSync(join(p.dir, "src", "ui", "new.ts"), "untracked\n");

  const r = p.run("surfaces", "main");
  assert.equal(r.stderr, "");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");

  const json = p.run("surfaces", "main", "--json");
  assert.equal(json.stdout, "[]\n");
});

test("deleting a file, or moving it out of a Surface, touches the Surface", (t) => {
  const p = project(t, { contract: contract(SURFACES), files: BASE_FILES });
  p.git("checkout", "--quiet", "-b", "issue-7");
  commit(p, { "index.html": null });
  p.git("mv", "src/ui/panel.ts", "src/core/panel.ts");
  p.git("commit", "--quiet", "-m", "Moves the panel");

  const r = p.run("surfaces", "main", "--json");

  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [{ name: "ui", files: ["index.html", "src/ui/panel.ts"] }]);
});

test("a Project with no Surfaces touches none, whatever the branch changed", (t) => {
  const p = project(t, { contract: contract([]), files: BASE_FILES });
  p.git("checkout", "--quiet", "-b", "issue-7");
  commit(p, { "src/ui/panel.ts": "changed\n", "index.html": "changed\n" });

  const r = p.run("surfaces", "main");

  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "");
});

test("surfaces fails on a base it cannot find, and on a call without a base", (t) => {
  const p = project(t, { contract: contract(SURFACES) });

  const unknown = p.run("surfaces", "origin/trunk");
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /^verkstad surfaces: cannot tell where HEAD left origin\/trunk: /);

  for (const args of [[], ["main", "--all"], ["main", "other"]]) {
    const r = p.run("surfaces", ...args);
    assert.equal(r.code, 2, `surfaces ${args.join(" ")}`);
    assert.match(r.stderr, /usage: verkstad surfaces <base> \[--json\]\n$/);
  }
});

test("a malformed surfaces field fails naming the field", (t) => {
  const cases: Array<[unknown, string]> = [
    [undefined, "surfaces must be an array of Surfaces ([] for a Project with none)"],
    [{ ui: ["src/**"] }, "surfaces must be an array of Surfaces ([] for a Project with none)"],
    [["ui"], "surfaces[0] must be an object"],
    [[{ name: "", globs: ["src/**"] }], "surfaces[0].name must be a non-empty string"],
    [[{ name: "ui", globs: [] }], "surfaces[0].globs must be a non-empty array of globs"],
    [[{ name: "ui", globs: ["src/**", 3] }], "surfaces[0].globs[1] must be a non-empty string"],
    [[{ name: "ui", globs: [":(exclude)src/**"] }], "surfaces[0].globs[0] ':(exclude)src/**' must be a glob relative to the Project's root, without pathspec magic"],
    [[{ name: "ui", globs: ["src/**"], verify: true }], "surfaces[0] has an unknown field 'verify' (known: name, globs)"],
    [[{ name: "ui", globs: ["a/**"] }, { name: "ui", globs: ["b/**"] }], "surfaces[1].name 'ui' is already the name of surfaces[0]"],
  ];
  for (const [surfaces, problem] of cases) {
    const p = project(t, { contract: contract(surfaces) });

    const r = p.run("surfaces", "main");

    assert.equal(r.code, 1, JSON.stringify(surfaces));
    assert.equal(r.stderr, `verkstad surfaces: .claude/harness.json: ${problem}\n`);
  }
});
