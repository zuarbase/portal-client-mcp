import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const registry = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "zuar-cli-")),
  "portals.json",
);
const env = { ...process.env, ZUAR_PORTAL_REGISTRY: registry };

function run(args) {
  try {
    const stdout = execFileSync("node", [ENTRY, ...args], { env, encoding: "utf8" });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

test("unknown CLI command errors with usage instead of starting the server", () => {
  const r = run(["help"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown command: help/);
  assert.match(r.stderr, /usage:/);
});

test("add without arguments errors with usage", () => {
  const r = run(["add"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage:/);
});

test("list works on an empty registry", () => {
  const r = run(["list"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /"portals": \{\}/);
});
