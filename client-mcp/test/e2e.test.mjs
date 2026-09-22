import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakePortal } from "./fixture-portal.mjs";
import { ClientMcp } from "./driver.mjs";

function registryWith(portals) {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "zuar-e2e-")),
    "portals.json",
  );
  fs.writeFileSync(file, JSON.stringify({ portals }));
  return file;
}

test("a session with no portals offers only the client's own tools", async () => {
  const registry = registryWith({});
  const client = new ClientMcp({ ZUAR_PORTAL_REGISTRY: registry });
  await client.init();
  const names = (await client.request("tools/list")).result.tools
    .map((tool) => tool.name)
    .sort();
  assert.deepEqual(names, [
    "connect_portal",
    "list_portals",
    "remove_portal",
    "use_portal",
  ]);
  client.close();
});

test("client-mcp end to end", async (t) => {
  const acme = await startFakePortal({ portalName: "acme", version: "1.20.3" });
  const widgets = await startFakePortal({
    portalName: "widgets",
    version: "1.20.1",
  });
  const globex = await startFakePortal({
    portalName: "globex",
    version: "1.21.0",
  });
  t.after(async () => {
    await Promise.all([acme.close(), widgets.close(), globex.close()]);
  });

  // Registration is covered by the CLI and connect-form tests; these
  // cases are about routing, so they start from a written registry.
  const registry = registryWith({
    acme: { url: acme.url, apiKey: "k1", version: "1.20.3" },
    widgets: { url: widgets.url, apiKey: "k2", version: "1.20.1" },
    globex: { url: globex.url, apiKey: "k3", version: "1.21.0" },
  });

  const client = new ClientMcp({ ZUAR_PORTAL_REGISTRY: registry });
  await client.init();

  await t.test("binding a portal dedups and injects the enum", async () => {
    const bound = await client.call("use_portal", { alias: "acme" });
    assert.equal(bound.isError, false);

    const tools = (await client.request("tools/list")).result.tools;
    const listPages = tools.find((tool) => tool.name === "list_pages");
    assert.ok(listPages, "portal tools present after binding");
    assert.deepEqual(listPages.inputSchema.properties.portal.enum, [
      "acme",
      "widgets",
    ]);
  });

  await t.test("routing honors portal argument and session default", async () => {
    let r = await client.call("list_pages", { portal: "widgets" });
    assert.match(r.text, /"portal":"widgets"/);
    r = await client.call("get_portal_info", {});
    assert.match(r.text, /"portal":"acme"/);
  });

  await t.test("version group mismatch is refused", async () => {
    const r = await client.call("use_portal", { alias: "globex" });
    assert.equal(r.isError, true);
    assert.match(r.text, /version group 1\.21/);
  });

  await t.test("list_portals scopes: session filters, all shows registry", async () => {
    const session = JSON.parse((await client.call("list_portals", {})).text);
    assert.deepEqual(Object.keys(session.portals).sort(), ["acme", "widgets"]);
    const all = JSON.parse(
      (await client.call("list_portals", { scope: "all" })).text,
    );
    assert.deepEqual(
      Object.keys(all.portals).sort(),
      ["acme", "globex", "widgets"],
    );
  });

  await t.test("resources are proxied from the group", async () => {
    const r = await client.request("resources/read", {
      uri: "zportal://skills/authoring",
    });
    assert.match(r.result.contents[0].text, /skills for 1\.20/);
  });

  client.close();

  await t.test("eager bind via ZUAR_PORTAL env", async () => {
    const c2 = new ClientMcp({
      ZUAR_PORTAL_REGISTRY: registry,
      ZUAR_PORTAL: "widgets",
    });
    await c2.init();
    const names = (await c2.request("tools/list")).result.tools.map(
      (tool) => tool.name,
    );
    assert.ok(names.includes("list_pages"), "full toolset from first list");
    const r = await c2.call("get_portal_info", {});
    assert.match(r.text, /"portal":"widgets"/);
    c2.close();
  });

  await t.test("remove_portal closes client and shrinks the enum", async () => {
    const c3 = new ClientMcp({
      ZUAR_PORTAL_REGISTRY: registry,
      ZUAR_PORTAL: "acme",
    });
    await c3.init();
    const r = await c3.call("remove_portal", { alias: "widgets" });
    assert.equal(r.isError, false);
    const tools = (await c3.request("tools/list")).result.tools;
    const listPages = tools.find((tool) => tool.name === "list_pages");
    assert.deepEqual(listPages.inputSchema.properties.portal.enum, ["acme"]);
    c3.close();
  });
});

test("a portal registered before it was ever reached learns its group", async (t) => {
  const portal = await startFakePortal({ portalName: "late", version: "1.22.0" });
  t.after(() => portal.close());
  // No version recorded: the entry predates any successful connect.
  const registry = registryWith({ late: { url: portal.url, apiKey: "k" } });

  const client = new ClientMcp({ ZUAR_PORTAL_REGISTRY: registry });
  await client.init();
  const bound = JSON.parse((await client.call("use_portal", { alias: "late" })).text);
  assert.equal(bound.bound_group, "1.22");
  client.close();
});

test("a session keeps portals other sessions registered after it started", async () => {
  const registry = registryWith({
    alpha: { url: "https://alpha.example/", apiKey: "ka", version: "1.21.0" },
    beta: { url: "https://beta.example/", apiKey: "kb", version: "1.21.0" },
  });
  const client = new ClientMcp({ ZUAR_PORTAL_REGISTRY: registry });
  await client.init();

  // Another session registers gamma while this one is running.
  const onDisk = JSON.parse(fs.readFileSync(registry, "utf8"));
  onDisk.portals.gamma = {
    url: "https://gamma.example/",
    apiKey: "kg",
    version: "1.21.0",
  };
  fs.writeFileSync(registry, JSON.stringify(onDisk));

  const listed = JSON.parse(
    (await client.call("list_portals", { scope: "all" })).text,
  );
  assert.deepEqual(Object.keys(listed.portals).sort(), ["alpha", "beta", "gamma"]);

  const r = await client.call("remove_portal", { alias: "alpha" });
  assert.equal(r.isError, false);
  const after = JSON.parse(fs.readFileSync(registry, "utf8")).portals;
  assert.deepEqual(Object.keys(after).sort(), ["beta", "gamma"]);
  assert.equal(after.gamma.apiKey, "kg");
  client.close();
});
