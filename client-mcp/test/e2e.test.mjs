import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakePortal } from "./fixture-portal.mjs";
import { ClientMcp } from "./driver.mjs";

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
  const registry = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "zuar-e2e-")),
    "portals.json",
  );

  const client = new ClientMcp({ ZUAR_PORTAL_REGISTRY: registry });
  await client.init();

  await t.test("unbound start exposes only own tools", async () => {
    const r = await client.request("tools/list");
    assert.deepEqual(
      r.result.tools.map((x) => x.name).sort(),
      ["add_portal", "list_portals", "remove_portal", "use_portal"],
    );
  });

  await t.test("add_portal binds, dedups, injects portal enum", async () => {
    let r = await client.call("add_portal", {
      alias: "acme",
      url: acme.url,
      api_key: "k1",
    });
    assert.equal(r.isError, false);
    r = await client.call("add_portal", {
      alias: "widgets",
      url: widgets.url,
      api_key: "k2",
    });
    assert.equal(r.isError, false);
    r = await client.call("add_portal", {
      alias: "globex",
      url: globex.url,
      api_key: "k3",
    });
    assert.match(r.text, /differs from the session group/);

    const tools = (await client.request("tools/list")).result.tools;
    const lp = tools.find((x) => x.name === "list_pages");
    assert.ok(lp, "portal tools present after binding");
    assert.deepEqual(lp.inputSchema.properties.portal.enum, [
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
    assert.match(r.result.contents[0].text, /guide for 1\.20/);
  });

  client.close();

  await t.test("eager bind via ZUAR_PORTAL env", async () => {
    const c2 = new ClientMcp({
      ZUAR_PORTAL_REGISTRY: registry,
      ZUAR_PORTAL: "widgets",
    });
    await c2.init();
    const names = (await c2.request("tools/list")).result.tools.map(
      (x) => x.name,
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
    const lp = tools.find((x) => x.name === "list_pages");
    assert.deepEqual(lp.inputSchema.properties.portal.enum, ["acme"]);
    c3.close();
  });

  await Promise.all([acme.close(), widgets.close(), globex.close()]);
});
