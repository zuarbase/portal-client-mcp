import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zuar-reg-"));
process.env.ZUAR_PORTAL_REGISTRY = path.join(tmp, "portals.json");
const { groupOf, loadRegistry, saveRegistry, findCwdPin } = await import(
  "../dist/registry.js"
);

test("groupOf extracts major.minor", () => {
  assert.equal(groupOf("1.20.3"), "1.20");
  assert.equal(groupOf("1.21.0"), "1.21");
  assert.equal(groupOf(undefined), "unknown");
  assert.equal(groupOf("weird"), "weird");
});

test("registry roundtrip and empty default", () => {
  assert.deepEqual(loadRegistry(), { portals: {} });
  saveRegistry({
    portals: { a: { url: "http://x/", apiKey: "k", version: "1.20.0" } },
  });
  assert.equal(loadRegistry().portals.a.version, "1.20.0");
});

test("findCwdPin walks up from nested folders", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "zuar-pin-"));
  fs.mkdirSync(path.join(base, ".zuar-portal"));
  fs.writeFileSync(
    path.join(base, ".zuar-portal", "config.json"),
    JSON.stringify({ default_portal: "acme" }),
  );
  const nested = path.join(base, "a", "b");
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(findCwdPin(nested), "acme");
  assert.equal(findCwdPin(fs.mkdtempSync(path.join(os.tmpdir(), "zx-"))), null);
});
