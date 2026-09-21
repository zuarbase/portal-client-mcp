// Transport resilience: the client behind a proxy that can drop the
// socket mid-request, the way keep-alive sockets die under a VPN flap.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { startFakePortal } from "./fixture-portal.mjs";
import { ClientMcp } from "./driver.mjs";

function registryWith(portals) {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "zuar-resilience-")),
    "portals.json",
  );
  fs.writeFileSync(file, JSON.stringify({ portals }));
  return file;
}

/**
 * Forwards every request to the fake portal. While `dropAll` is set, or
 * for the next `dropNext` JSON-RPC requests, it reads the request body
 * and then destroys the socket without answering — undici reports that
 * as `TypeError: fetch failed` with UND_ERR_SOCKET or ECONNRESET
 * underneath. Only requests carrying a JSON-RPC body are recorded and
 * dropped, so the transport's fire-and-forget GET stream stays out of
 * the counts.
 */
async function startFlakyProxy(targetUrl) {
  const target = new URL(targetUrl);
  const proxy = {
    dropNext: 0,
    dropAll: false,
    /** {method, tool, connection} per JSON-RPC request, in arrival order. */
    seen: [],
    url: "",
    close: async () => {},
  };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    let msg = null;
    try {
      msg = JSON.parse(body.toString());
    } catch {
      // not JSON-RPC (the GET stream probe)
    }
    if (msg?.method) {
      proxy.seen.push({
        method: msg.method,
        tool: msg.params?.name,
        connection: req.headers.connection ?? "",
      });
      if (proxy.dropAll || proxy.dropNext > 0) {
        if (proxy.dropNext > 0) proxy.dropNext--;
        req.socket.destroy();
        return;
      }
    }
    // Connection and Keep-Alive are hop-by-hop: they describe this leg
    // only. Forwarded upstream, a "close" would make the portal's parser
    // reject the next request Node's pooled client sends on that socket.
    const {
      connection: _conn,
      "keep-alive": _ka,
      host: _host,
      ...forwarded
    } = req.headers;
    const upstream = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: req.url,
        method: req.method,
        headers: { ...forwarded, host: target.host },
      },
      (up) => {
        // Let this server decide keep-alive from the client's request.
        const { connection: _c, "keep-alive": _k, ...headers } = up.headers;
        res.writeHead(up.statusCode, headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => res.destroy());
    // The portal's SSE stream (a long-lived GET) would otherwise outlive
    // the client and keep the portal from closing.
    res.on("close", () => upstream.destroy());
    upstream.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  proxy.url = `http://127.0.0.1:${server.address().port}/`;
  proxy.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    });
  return proxy;
}

/** A URL on which nothing listens: every connect is refused. */
async function refusedUrl() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}/`;
}

test("forwarded calls are repeated only when the request never left", async (t) => {
  const portal = await startFakePortal({ portalName: "acme", version: "1.20.3" });
  const proxy = await startFlakyProxy(portal.url);
  const registry = registryWith({
    acme: { url: proxy.url, apiKey: "k1", version: "1.20.3" },
    dead: { url: await refusedUrl(), apiKey: "k2", version: "1.20.3" },
  });
  const client = new ClientMcp({ ZUAR_PORTAL_REGISTRY: registry, ZUAR_PORTAL: "acme" });
  t.after(async () => {
    client.close();
    await proxy.close();
    await portal.close();
  });
  await client.init();
  const names = (await client.request("tools/list")).result.tools.map((x) => x.name);
  assert.ok(names.includes("create_thing"), "fixture offers a write-named tool");

  await t.test("a call whose socket died after sending is not repeated", async () => {
    proxy.seen.length = 0;
    proxy.dropNext = 1;
    const r = await client.call("create_thing", { entity_type: "thing", name: "widget" });
    assert.equal(r.isError, true);
    assert.match(
      r.text,
      /^create_thing on acme: the connection broke after the request was sent \(TypeError: fetch failed \((UND_ERR_SOCKET|ECONNRESET): /,
    );
    assert.match(r.text, /list_change_sets for thing, newest first/);
    // sent once, no reconnect: the caller decides whether to repeat it
    assert.deepEqual(proxy.seen.map((s) => s.method), ["tools/call"]);
    console.log(`ambiguous delivery error text: ${r.text}`);
  });

  await t.test("the next call reconnects, and asks the server to close the socket", async () => {
    proxy.seen.length = 0;
    const r = await client.call("create_thing", { name: "widget" });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /"created":"widget"/);
    assert.deepEqual(
      proxy.seen.map((s) => s.method),
      ["initialize", "notifications/initialized", "tools/call"],
    );
    assert.ok(
      proxy.seen.every((s) => s.connection === "close"),
      JSON.stringify(proxy.seen),
    );
  });

  await t.test("a handshake that keeps failing is retried, then reports the cause code", async () => {
    proxy.seen.length = 0;
    proxy.dropAll = true;
    // the first call after a failure reconnects: a dead handshake never
    // carries the call, so it is safe to repeat up to three times
    const r1 = await client.call("get_portal_info", {});
    proxy.dropAll = false;
    assert.equal(r1.isError, true);
    assert.match(r1.text, /^get_portal_info on acme: the connection broke after the request was sent/);
    proxy.seen.length = 0;
    proxy.dropAll = true;
    const r = await client.call("get_portal_info", {});
    proxy.dropAll = false;
    assert.equal(r.isError, true);
    assert.match(r.text, /^TypeError: fetch failed \((UND_ERR_SOCKET|ECONNRESET): /);
    assert.doesNotMatch(r.text, /may have been delivered/);
    assert.deepEqual(
      proxy.seen.map((s) => s.method),
      ["initialize", "initialize", "initialize"],
    );
  });

  await t.test("the session recovers once the network is back", async () => {
    const r = await client.call("get_portal_info", {});
    assert.equal(r.isError, false, r.text);
  });

  await t.test("a portal that refuses connections is retried even for writes", async () => {
    const r = await client.call("create_thing", { portal: "dead", name: "x" });
    assert.equal(r.isError, true);
    assert.match(r.text, /^TypeError: fetch failed \(ECONNREFUSED: /);
    assert.doesNotMatch(r.text, /may have been delivered/);
  });

  await t.test("a refusal from the portal itself is passed through, not retried", async () => {
    proxy.seen.length = 0;
    const r = await client.call("no_such_tool", {});
    assert.equal(r.isError, true);
    assert.match(r.text, /unknown tool no_such_tool/);
    assert.deepEqual(proxy.seen.map((s) => s.method), ["tools/call"]);
  });
});
