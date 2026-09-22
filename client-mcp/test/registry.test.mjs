import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zuar-reg-"));
process.env.ZUAR_PORTAL_REGISTRY = path.join(tmp, "portals.json");
const { groupOf, loadRegistry, refreshRegistry, updateRegistry, findCwdPin } =
  await import(
  "../dist/registry.js"
);

test("groupOf extracts major.minor", () => {
  assert.equal(groupOf("1.20.3"), "1.20");
  assert.equal(groupOf("1.21.0"), "1.21");
  assert.equal(groupOf(undefined), "unknown");
  assert.equal(groupOf("weird"), "weird");
});

test("registry roundtrip and empty default", () => {
  const reg = loadRegistry();
  assert.deepEqual(reg, { portals: {} });
  updateRegistry(reg, (portals) => {
    portals.a = { url: "http://x/", apiKey: "k", version: "1.20.0" };
  });
  assert.equal(loadRegistry().portals.a.version, "1.20.0");
});

test("updateRegistry keeps entries written after this copy was loaded", () => {
  const file = process.env.ZUAR_PORTAL_REGISTRY;
  fs.writeFileSync(file, JSON.stringify({ portals: { a: { url: "http://a/", apiKey: "ka" } } }));
  const mine = loadRegistry();
  // another session adds b
  fs.writeFileSync(
    file,
    JSON.stringify({
      portals: {
        a: { url: "http://a/", apiKey: "ka" },
        b: { url: "http://b/", apiKey: "kb" },
      },
    }),
  );
  updateRegistry(mine, (portals) => {
    delete portals.a;
  });
  assert.deepEqual(Object.keys(loadRegistry().portals), ["b"]);
  assert.equal(loadRegistry().portals.b.apiKey, "kb");
  // Windows has no POSIX modes: every file reads back as 0666.
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
});

test("updateRegistry refuses to overwrite a file it cannot parse", () => {
  const file = process.env.ZUAR_PORTAL_REGISTRY;
  fs.writeFileSync(file, "{ not json");
  const reg = { portals: {} };
  assert.throws(() =>
    updateRegistry(reg, (portals) => {
      portals.c = { url: "http://c/", apiKey: "kc" };
    }),
  );
  assert.equal(fs.readFileSync(file, "utf8"), "{ not json");
});

test("a failed write leaves memory as it was", () => {
  const file = process.env.ZUAR_PORTAL_REGISTRY;
  fs.writeFileSync(file, "{ not json");
  const reg = { portals: { a: { url: "http://a/", apiKey: "ka" } } };
  assert.throws(() =>
    updateRegistry(reg, (portals) => {
      delete portals.a;
    }),
  );
  assert.deepEqual(Object.keys(reg.portals), ["a"]);
});

test("a registry whose portals is an array is refused, not written to", () => {
  const file = process.env.ZUAR_PORTAL_REGISTRY;
  fs.writeFileSync(file, JSON.stringify({ portals: [] }));
  assert.throws(
    () =>
      updateRegistry({ portals: {} }, (portals) => {
        portals.c = { url: "http://c/", apiKey: "kc" };
      }),
    /no "portals" object/,
  );
  assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify({ portals: [] }));
});

test("refreshRegistry picks up the file and keeps the copy on a bad read", () => {
  const file = process.env.ZUAR_PORTAL_REGISTRY;
  const reg = { portals: {} };
  fs.writeFileSync(file, JSON.stringify({ portals: { d: { url: "http://d/", apiKey: "kd" } } }));
  refreshRegistry(reg);
  assert.deepEqual(Object.keys(reg.portals), ["d"]);
  fs.writeFileSync(file, "{ not json");
  refreshRegistry(reg);
  assert.deepEqual(Object.keys(reg.portals), ["d"]);
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
