import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// The tag IS the version (README, "Release"). main carries the
// development sentinel in both manifests, and only the CI release
// commit ("release vX.Y.Z" on the release branch) carries a real
// number, stamped from the tag. A hand bump on main would make a
// checkout report a release it is not, which is what this guards.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel) => JSON.parse(fs.readFileSync(new URL(rel, `file://${ROOT}`), "utf8"));

test("manifests carry 0.0.0-dev unless HEAD is a CI release commit", () => {
  const subject = execFileSync("git", ["log", "-1", "--format=%s"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  const stamped = subject.match(/^release v(\d+\.\d+\.\d+)$/);
  const expected = stamped ? stamped[1] : "0.0.0-dev";
  assert.equal(read("client-mcp/package.json").version, expected);
  assert.equal(read("client-mcp/package-lock.json").version, expected);
  assert.equal(read(".claude-plugin/plugin.json").version, expected);
});
