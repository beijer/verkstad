import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { project } from "./project.ts";

test("an unknown subcommand is a usage error that lists the subcommands", (t) => {
  const p = project(t);

  const r = p.run("fronteir");

  assert.equal(r.code, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^verkstad: no subcommand 'fronteir'\n/);
  assert.match(r.stderr, /^ {2}verkstad frontier \[--json\] +Lists the Tickets/m);
  assert.deepEqual(p.calls(), []);
});

test("verkstad runs through a symlink on the PATH, as a plugin's bin/ or a Project's PATH puts it", (t) => {
  const p = project(t, { issues: [{ number: 2, title: "Plugin skeleton", labels: ["ready-for-agent"] }] });
  const links = join(p.dir, "..", "links");
  mkdirSync(links);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  symlinkSync(join(root, "bin", "verkstad"), join(links, "verkstad"));

  const r = spawnSync("verkstad", ["frontier"], {
    cwd: p.dir,
    encoding: "utf8",
    env: { ...p.env, PATH: `${links}:${p.env.PATH}` },
  });

  assert.equal(r.stderr, "");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^Ready \(1\):\n {2}#2 Plugin skeleton\n/);
});
