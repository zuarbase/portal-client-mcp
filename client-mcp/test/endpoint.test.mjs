import test from "node:test";
import assert from "node:assert/strict";

import { mcpEndpointUrl } from "../dist/registry.js";

test("a bare portal URL gets the MCP endpoint path", () => {
  assert.equal(
    mcpEndpointUrl("https://acme.example.com"),
    "https://acme.example.com/services/portal-mcp/mcp",
  );
  assert.equal(
    mcpEndpointUrl("https://acme.example.com/"),
    "https://acme.example.com/services/portal-mcp/mcp",
  );
});

test("a hostname without a scheme is assumed https", () => {
  assert.equal(
    mcpEndpointUrl("acme.example.com"),
    "https://acme.example.com/services/portal-mcp/mcp",
  );
});

test("surrounding whitespace is ignored", () => {
  assert.equal(
    mcpEndpointUrl("  https://acme.example.com  "),
    "https://acme.example.com/services/portal-mcp/mcp",
  );
});

test("a URL that already carries a path is kept verbatim", () => {
  const explicit = "http://127.0.0.1:8300/mcp";
  assert.equal(mcpEndpointUrl(explicit), explicit);
  const proxied = "https://acme.example.com/services/portal-mcp/mcp";
  assert.equal(mcpEndpointUrl(proxied), proxied);
});

test("a port survives the rewrite", () => {
  assert.equal(
    mcpEndpointUrl("https://acme.example.com:8443"),
    "https://acme.example.com:8443/services/portal-mcp/mcp",
  );
});
