import test from "node:test";
import assert from "node:assert/strict";

import { ConnectFormError, requestApiKey } from "../dist/connect-form.js";

test("the form hands the key to the client and nothing else", async () => {
  let formUrl;
  const key = requestApiKey({
    portalUrl: "https://acme.example.com",
    alias: "acme",
    timeoutMs: 5000,
    onReady: (u) => (formUrl = u),
  });
  await new Promise((r) => setTimeout(r, 10));

  const page = await (await fetch(formUrl)).text();
  assert.match(page, /Admin API key/);
  assert.match(page, /acme\.example\.com/);
  assert.doesNotMatch(page, /value="/, "the field is never prefilled");

  const response = await fetch(formUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ api_key: "secret-key" }),
  });
  assert.match(await response.text(), /Connected/);
  assert.equal(await key, "secret-key");
});

test("the port is not usable without the path token", async () => {
  let formUrl;
  const key = requestApiKey({
    portalUrl: "https://acme.example.com",
    alias: "acme",
    timeoutMs: 5000,
    onReady: (u) => (formUrl = u),
  });
  await new Promise((r) => setTimeout(r, 10));

  const origin = new URL(formUrl).origin;
  for (const path of ["/", "/submit", "/deadbeef"]) {
    const res = await fetch(`${origin}${path}`, { method: "POST" });
    assert.equal(res.status, 404, `${path} must not accept a key`);
  }

  await fetch(formUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ api_key: "k" }),
  });
  await key;
});

test("an empty submission does not register anything", async () => {
  let formUrl;
  const key = requestApiKey({
    portalUrl: "https://acme.example.com",
    alias: "acme",
    timeoutMs: 5000,
    onReady: (u) => (formUrl = u),
  });
  await new Promise((r) => setTimeout(r, 10));

  const res = await fetch(formUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ api_key: "   " }),
  });
  assert.equal(res.status, 400);

  // still waiting: the real key still lands
  await fetch(formUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ api_key: "real" }),
  });
  assert.equal(await key, "real");
});

test("a form nobody fills in times out instead of hanging", async () => {
  await assert.rejects(
    requestApiKey({
      portalUrl: "https://acme.example.com",
      alias: "acme",
      timeoutMs: 50,
    }),
    ConnectFormError,
  );
});

test("the listener is closed once the key arrives", async () => {
  let formUrl;
  const key = requestApiKey({
    portalUrl: "https://acme.example.com",
    alias: "acme",
    timeoutMs: 5000,
    onReady: (u) => (formUrl = u),
  });
  await new Promise((r) => setTimeout(r, 10));
  await fetch(formUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ api_key: "k" }),
  });
  await key;
  await assert.rejects(fetch(formUrl));
});

test("a missing browser opener is reported, not fatal", async () => {
  const { openBrowser } = await import("../dist/connect-form.js");
  const path = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    assert.equal(await openBrowser("http://127.0.0.1:1/x"), false);
  } finally {
    process.env.PATH = path;
  }
});
