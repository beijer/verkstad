import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
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
  const dir = mkdtempSync(join(tmpdir(), "verkstad-link-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  symlinkSync(join(root, "bin", "verkstad"), join(dir, "verkstad"));

  const r = spawnSync("verkstad", ["--help"], {
    encoding: "utf8",
    env: { PATH: `${dir}:${process.env.PATH}` },
  });

  assert.equal(r.stderr, "");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^usage: verkstad <subcommand>/);
  assert.match(r.stdout, /verkstad frontier \[--json\]/);
});
