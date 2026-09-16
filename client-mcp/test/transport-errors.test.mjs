import test from "node:test";
import assert from "node:assert/strict";

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import {
  ambiguousWriteMessage,
  classifyTransportFailure,
  describeError,
  isWriteTool,
  noteConnectionFailure,
  pooledSocketsSuspect,
} from "../dist/transport-errors.js";

/** What undici throws: a bare TypeError with the socket error as its cause. */
function fetchFailed(code, message) {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error(message), { code }),
  });
}

test("describeError names the error and walks the cause chain", () => {
  const err = new TypeError("fetch failed");
  err.cause = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  assert.equal(
    describeError(err),
    "TypeError: fetch failed (ECONNRESET: socket hang up)",
  );
});

test("describeError renders an AggregateError cause through its inner errors", () => {
  // What a refused `localhost` looks like: one attempt per address family.
  const agg = new AggregateError([
    Object.assign(new Error("connect ECONNREFUSED ::1:9"), { code: "ECONNREFUSED" }),
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" }),
  ]);
  agg.code = "ECONNREFUSED";
  assert.equal(
    describeError(new TypeError("fetch failed", { cause: agg })),
    "TypeError: fetch failed (ECONNREFUSED: connect ECONNREFUSED ::1:9; " +
      "connect ECONNREFUSED 127.0.0.1:9)",
  );
});

test("describeError leaves errors without a cause and non-errors alone", () => {
  assert.equal(describeError(new Error("boom")), "Error: boom");
  assert.equal(
    describeError(new McpError(ErrorCode.InvalidParams, "no such tool")),
    "McpError: MCP error -32602: no such tool",
  );
  assert.equal(describeError("plain string"), "plain string");
});

test("classifyTransportFailure: refused and unresolvable hosts were never sent", () => {
  for (const [code, message] of [
    ["ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:443"],
    ["ENOTFOUND", "getaddrinfo ENOTFOUND acme.example.com"],
    ["EAI_AGAIN", "getaddrinfo EAI_AGAIN acme.example.com"],
  ]) {
    assert.equal(classifyTransportFailure(fetchFailed(code, message)), "never-sent", code);
  }
});

test("classifyTransportFailure: a broken connection is ambiguous", () => {
  for (const [code, message] of [
    ["ECONNRESET", "socket hang up"],
    ["ETIMEDOUT", "connect ETIMEDOUT 10.0.0.1:443"],
    ["EPIPE", "write EPIPE"],
    ["ECONNABORTED", "aborted"],
    ["EHOSTUNREACH", "connect EHOSTUNREACH 10.0.0.1:443"],
    ["ENETUNREACH", "connect ENETUNREACH 10.0.0.1:443"],
    ["UND_ERR_SOCKET", "other side closed"],
    ["UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error"],
    ["UND_ERR_HEADERS_TIMEOUT", "Headers Timeout Error"],
    ["UND_ERR_BODY_TIMEOUT", "Body Timeout Error"],
  ]) {
    assert.equal(classifyTransportFailure(fetchFailed(code, message)), "ambiguous", code);
  }
  assert.equal(classifyTransportFailure(new TypeError("fetch failed")), "ambiguous");
  const abort = new Error("This operation was aborted");
  abort.name = "AbortError";
  assert.equal(classifyTransportFailure(abort), "ambiguous");
});

test("classifyTransportFailure: the deepest code in the chain decides", () => {
  const err = new TypeError("fetch failed", {
    cause: Object.assign(new Error("wrapper"), {
      code: "UND_ERR_SOCKET",
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    }),
  });
  assert.equal(classifyTransportFailure(err), "never-sent");
});

test("classifyTransportFailure: anything the portal answered is not a transport failure", () => {
  assert.equal(classifyTransportFailure(new Error("boom")), "not-transport");
  assert.equal(
    classifyTransportFailure(new McpError(ErrorCode.InvalidParams, "no such tool")),
    "not-transport",
  );
  assert.equal(classifyTransportFailure("a thrown string"), "not-transport");
  assert.equal(classifyTransportFailure(undefined), "not-transport");
});

const tool = (name, annotations) => ({
  name,
  inputSchema: { type: "object" },
  ...(annotations ? { annotations } : {}),
});

test("isWriteTool trusts the tool's annotations over its name", () => {
  assert.equal(isWriteTool("create_entity", [tool("create_entity", { readOnlyHint: true })]), false);
  assert.equal(isWriteTool("get_entity", [tool("get_entity", { readOnlyHint: false })]), true);
  assert.equal(isWriteTool("get_entity", [tool("get_entity", { destructiveHint: true })]), true);
  // readOnlyHint wins over destructiveHint when both are set
  assert.equal(
    isWriteTool("purge", [tool("purge", { readOnlyHint: true, destructiveHint: true })]),
    false,
  );
});

test("isWriteTool falls back to the name prefix", () => {
  const tools = [tool("create_entity"), tool("get_entity", {})];
  for (const name of ["create_entity", "update_entity", "delete_entity", "place_blocks", "revert_change_set"]) {
    assert.equal(isWriteTool(name, tools), true, name);
  }
  for (const name of ["get_entity", "list_entities", "execute_sql", "validate_entity", "get_portal_info"]) {
    assert.equal(isWriteTool(name, tools), false, name);
  }
});

test("ambiguousWriteMessage names the check and the entity when known", () => {
  const cause = fetchFailed("ECONNRESET", "socket hang up");
  assert.equal(
    ambiguousWriteMessage("update_entity", "acme", { entity_type: "page", id: 42 }, cause),
    "update_entity on acme failed after the request may have been delivered " +
      "(TypeError: fetch failed (ECONNRESET: socket hang up)). The write may " +
      "have applied: call list_change_sets for page 42 filtered to your own " +
      "changes, newest first, before retrying. For create_entity, search " +
      "list_entities by the name you sent.",
  );
  assert.match(
    ambiguousWriteMessage("create_entity", "acme", { entity_type: "page", name: "Home" }, cause),
    /call list_change_sets for page filtered to your own changes/,
  );
  assert.match(
    ambiguousWriteMessage("place_blocks", "acme", {}, cause),
    /call list_change_sets filtered to your own changes/,
  );
});

test("a connection failure makes pooled sockets suspect for one minute", () => {
  const t0 = 1_000_000;
  assert.equal(pooledSocketsSuspect(t0), false);
  noteConnectionFailure(t0);
  assert.equal(pooledSocketsSuspect(t0), true);
  assert.equal(pooledSocketsSuspect(t0 + 59_999), true);
  assert.equal(pooledSocketsSuspect(t0 + 60_000), false);
});
