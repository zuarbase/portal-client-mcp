import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { startFakePortal } from "./fixture-portal.mjs";
import { ClientMcp } from "./driver.mjs";

function freshRegistryPath() {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "zuar-env-")),
    "portals.json",
  );
}

test("the environment portal is bound from the first tools/list", async (t) => {
  const portal = await startFakePortal({
    portalName: "harness",
    version: "1.21.4",
  });
  const registry = freshRegistryPath();
  const client = new ClientMcp({
    ZUAR_PORTAL_REGISTRY: registry,
    ZUAR_PORTAL_URL: portal.url,
    ZUAR_PORTAL_API_KEY: "key-from-env",
  });
  await client.init();

  await t.test("portal tools are present without any registration", async () => {
    const names = (await client.request("tools/list")).result.tools.map(
      (tool) => tool.name,
    );
    assert.ok(names.includes("list_pages"));
  });

  await t.test("calls reach the portal with no explicit target", async () => {
    const { text } = await client.call("get_portal_info", {});
    assert.match(text, /"portal":"harness"/);
  });

  await t.test("the key is never written to disk", async () => {
    assert.equal(fs.existsSync(registry), false);
  });

  await t.test("the registry cannot be changed from inside", async () => {
    const { isError, text } = await client.call("add_portal", {
      alias: "other",
      url: "https://other.example.com",
      api_key: "k",
    });
    assert.equal(isError, true);
    assert.match(text, /ZUAR_PORTAL_URL/);
  });

  client.close();
  await portal.close();
});

test("the environment portal replaces the file registry", async () => {
  const portal = await startFakePortal({ portalName: "env", version: "1.21.0" });
  const registry = freshRegistryPath();
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(
    registry,
    JSON.stringify({
      portals: { stale: { url: "https://stale.example.com", apiKey: "old" } },
    }),
  );

  const client = new ClientMcp({
    ZUAR_PORTAL_REGISTRY: registry,
    ZUAR_PORTAL_URL: portal.url,
    ZUAR_PORTAL_API_KEY: "k",
  });
  await client.init();
  const { text } = await client.call("list_portals", { scope: "all" });
  assert.doesNotMatch(text, /stale/);

  client.close();
  await portal.close();
});

test("a portal without a key is a setup error, not a silent fallback", () => {
  const registry = freshRegistryPath();
  const client = new ClientMcp({
    ZUAR_PORTAL_REGISTRY: registry,
    ZUAR_PORTAL_URL: "https://acme.example.com",
  });
  return new Promise((resolve) => {
    client.proc.on("exit", (code) => {
      assert.notEqual(code, 0);
      resolve();
    });
  });
});
