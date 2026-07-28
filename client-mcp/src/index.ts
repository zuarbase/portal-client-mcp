#!/usr/bin/env node
import { createRequire } from "node:module";

// Low-level Server on purpose: a transparent proxy re-emits foreign
// tool schemas verbatim — do not migrate to McpServer.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import {
  findCwdPin,
  groupOf,
  loadRegistry,
  saveRegistry,
  type Registry,
} from "./registry.js";

// Version source: package.json, stamped by CI from the git tag.
function resolveVersion(): string {
  try {
    const pkg = createRequire(import.meta.url)("../package.json") as {
      version?: string;
    };
    return pkg.version ?? "0.0.0-dev";
  } catch {
    return "0.0.0-dev";
  }
}

const CLIENT_MCP_VERSION = resolveVersion();

interface SessionState {
  registry: Registry;
  boundGroup: string | null;
  defaultPortal: string | null;
  clients: Map<string, Client>;
  upstreamTools: Tool[];
}

const state: SessionState = {
  registry: loadRegistry(),
  boundGroup: null,
  defaultPortal: null,
  clients: new Map(),
  upstreamTools: [],
};

function log(msg: string): void {
  process.stderr.write(`[zportal-client-mcp] ${msg}\n`);
}

async function connectPortal(alias: string): Promise<Client> {
  const cached = state.clients.get(alias);
  if (cached) return cached;
  const entry = state.registry.portals[alias];
  if (!entry) throw new Error(`unknown portal alias: ${alias}`);
  const client = new Client({ name: "zportal-client-mcp", version: CLIENT_MCP_VERSION });
  const transport = new StreamableHTTPClientTransport(new URL(entry.url), {
    requestInit: {
      headers: { Authorization: `Bearer ${entry.apiKey}` },
    },
  });
  await client.connect(transport);
  const serverVersion = client.getServerVersion()?.version;
  if (serverVersion && entry.version !== serverVersion) {
    entry.version = serverVersion;
    saveRegistry(state.registry);
  }
  state.clients.set(alias, client);
  return client;
}

function groupAliases(group: string): string[] {
  return Object.entries(state.registry.portals)
    .filter(([, e]) => groupOf(e.version) === group)
    .map(([alias]) => alias)
    .sort();
}

/**
 * Evict-reconnect-retry-once on upstream failure; a write whose
 * response was lost may execute twice (see README gaps).
 */
async function withClient<T>(
  alias: string,
  fn: (c: Client) => Promise<T>,
): Promise<T> {
  const client = await connectPortal(alias);
  try {
    return await fn(client);
  } catch (err) {
    log(`call to ${alias} failed (${String(err)}), reconnecting once`);
    state.clients.delete(alias);
    try {
      await client.close();
    } catch {
      // already closed
    }
    const fresh = await connectPortal(alias);
    return fn(fresh);
  }
}

/** Pick a live representative of the bound group, preferring the default portal. */
async function representativeAlias(): Promise<string> {
  if (!state.boundGroup) throw new Error("session is not bound to a version group");
  const order = groupAliases(state.boundGroup);
  if (state.defaultPortal && order.includes(state.defaultPortal)) {
    order.splice(order.indexOf(state.defaultPortal), 1);
    order.unshift(state.defaultPortal);
  }
  let lastError: unknown = null;
  for (const alias of order) {
    try {
      await connectPortal(alias);
      return alias;
    } catch (err) {
      lastError = err;
      log(`representative ${alias} unreachable: ${String(err)}`);
    }
  }
  throw new Error(`no reachable portal in group ${state.boundGroup}: ${String(lastError)}`);
}

async function withRepresentative<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const alias = await representativeAlias();
  return withClient(alias, fn);
}

const LIST_SCOPES = ["session", "all"] as const;
type ListScope = (typeof LIST_SCOPES)[number];
const DEFAULT_LIST_SCOPE: ListScope = "session";

const PORTAL_PARAM_DESCRIPTION =
  "Target portal alias. Optional when a session default is set via use_portal.";

function injectPortalParam(tool: Tool, aliases: string[]): Tool {
  const schema = tool.inputSchema ?? { type: "object" as const };
  return {
    ...tool,
    inputSchema: {
      ...schema,
      properties: {
        ...(schema.properties ?? {}),
        portal: {
          type: "string",
          enum: aliases,
          description: PORTAL_PARAM_DESCRIPTION,
        },
      },
    },
  };
}

async function bindGroup(group: string): Promise<void> {
  const repAlias = await (async () => {
    state.boundGroup = group;
    try {
      return await representativeAlias();
    } catch (err) {
      state.boundGroup = null;
      throw err;
    }
  })();
  const { tools } = await withClient(repAlias, (c) => c.listTools());
  const collisions = tools.filter((t) => t.inputSchema?.properties?.portal);
  if (collisions.length > 0) {
    // 'portal' is reserved for routing — overwrite, but surface it.
    log(
      `WARNING: upstream tools already define a 'portal' parameter, ` +
        `overwriting: ${collisions.map((t) => t.name).join(", ")}`,
    );
  }
  const aliases = groupAliases(group);
  state.upstreamTools = tools.map((t) => injectPortalParam(t, aliases));
  log(`bound to version group ${group} (${aliases.join(", ")}), ${tools.length} upstream tools`);
}

/** Explicit session target: `--portal <alias>` argv or ZUAR_PORTAL env. */
function explicitPortal(): string | null {
  const idx = process.argv.indexOf("--portal");
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.env.ZUAR_PORTAL ?? null;
}

/**
 * Eager binding: explicit portal → cwd pin → single-group registry.
 * Failures leave the session unbound; own tools still work.
 */
async function eagerBind(): Promise<void> {
  for (const alias of [explicitPortal(), findCwdPin()]) {
    if (!alias) continue;
    if (!state.registry.portals[alias]) {
      log(`requested portal ${alias} is not in the registry`);
      continue;
    }
    try {
      await connectPortal(alias);
      state.defaultPortal = alias;
      await bindGroup(groupOf(state.registry.portals[alias].version));
      return;
    } catch (err) {
      log(`bind to ${alias} failed: ${String(err)}`);
    }
  }
  const groups = new Set(
    Object.values(state.registry.portals).map((e) => groupOf(e.version)),
  );
  if (groups.size === 1) {
    const [group] = groups;
    if (group !== "unknown") {
      try {
        await bindGroup(group);
      } catch (err) {
        log(`single-group bind failed: ${String(err)}`);
      }
    }
  }
}

/**
 * CLI registry management (`add`/`list`/`remove`) — sessions start
 * pre-populated, since Codex can't refresh tools mid-session.
 */
async function runCli(cmd: string, rest: string[]): Promise<number> {
  if (cmd === "list") {
    console.log(JSON.stringify(portalSummary(), null, 2));
    return 0;
  }
  if (cmd === "add") {
    const [alias, url, apiKey] = rest;
    if (!alias || !url || !apiKey) {
      console.error("usage: index.js add <alias> <url> <api_key>");
      return 2;
    }
    state.registry.portals[alias] = { url, apiKey };
    try {
      await connectPortal(alias);
    } catch (err) {
      delete state.registry.portals[alias];
      console.error(`could not connect to ${url}: ${String(err)}`);
      return 1;
    }
    saveRegistry(state.registry);
    const entry = state.registry.portals[alias];
    console.log(
      JSON.stringify(
        { registered: alias, version: entry.version, group: groupOf(entry.version) },
        null,
        2,
      ),
    );
    return 0;
  }
  if (cmd === "remove") {
    const [alias] = rest;
    if (!alias || !state.registry.portals[alias]) {
      console.error(`unknown portal alias: ${alias}`);
      return 1;
    }
    delete state.registry.portals[alias];
    saveRegistry(state.registry);
    console.log(JSON.stringify({ removed: alias }));
    return 0;
  }
  console.error(
    `unknown command: ${cmd}\n` +
      "usage: index.js [add <alias> <url> <api_key> | list | remove <alias>]\n" +
      "       index.js [--portal <alias>]   (no command: run as MCP stdio server)",
  );
  return 2;
}

const cliCmd = process.argv[2];
if (cliCmd && cliCmd !== "--portal") {
  process.exit(await runCli(cliCmd, process.argv.slice(3)));
}

const bindingPromise = eagerBind();

const OWN_TOOLS: Tool[] = [
  {
    name: "list_portals",
    description:
      "List Zuar Portal instances. Default scope 'session' shows only " +
      "portals usable in this session (the bound version group) plus the " +
      "session default; scope 'all' shows the entire registry.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: [...LIST_SCOPES],
          description: `Defaults to '${DEFAULT_LIST_SCOPE}'.`,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "add_portal",
    description:
      "Register a Zuar Portal instance with the Client MCP and detect its version. " +
      "Binds the session to the portal's version group if the session is still unbound.",
    inputSchema: {
      type: "object",
      properties: {
        alias: { type: "string", description: "Short name, e.g. 'acme'" },
        url: { type: "string", description: "Portal MCP endpoint URL" },
        api_key: { type: "string", description: "Admin API key for this portal" },
      },
      required: ["alias", "url", "api_key"],
      additionalProperties: false,
    },
  },
  {
    name: "remove_portal",
    description: "Remove a portal from the registry.",
    inputSchema: {
      type: "object",
      properties: { alias: { type: "string" } },
      required: ["alias"],
      additionalProperties: false,
    },
  },
  {
    name: "use_portal",
    description:
      "Set the session's default target portal. The first call binds the session to " +
      "that portal's version group; portals of other groups are refused until a new session.",
    inputSchema: {
      type: "object",
      properties: { alias: { type: "string" } },
      required: ["alias"],
      additionalProperties: false,
    },
  },
];

function textResult(payload: unknown, isError = false) {
  const text =
    typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text" as const, text }], isError };
}

function portalSummary(scope: ListScope = "all") {
  const entries = Object.entries(state.registry.portals)
    .map(([alias, e]) => ({
      alias,
      url: e.url,
      version: e.version ?? "unknown",
      group: groupOf(e.version),
      usable_in_session:
        state.boundGroup === null || groupOf(e.version) === state.boundGroup,
    }))
    .filter((p) => scope === "all" || p.usable_in_session);
  const summary: Record<string, unknown> = {
    scope,
    bound_group: state.boundGroup,
    default_portal: state.defaultPortal,
    portals: Object.fromEntries(
      entries.map(({ alias, ...rest }) => [alias, rest]),
    ),
  };
  if (scope === "session" && state.boundGroup === null) {
    summary.note =
      "Session is unbound — this list is the whole registry. The first " +
      "use_portal call will bind the session to that portal's group.";
  }
  return summary;
}

async function handleOwnTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ReturnType<typeof textResult>> {
  switch (name) {
    case "list_portals": {
      const scope = LIST_SCOPES.includes(args.scope as ListScope)
        ? (args.scope as ListScope)
        : DEFAULT_LIST_SCOPE;
      return textResult(portalSummary(scope));
    }

    case "add_portal": {
      const alias = String(args.alias);
      const url = String(args.url);
      const apiKey = String(args.api_key);
      state.registry.portals[alias] = { url, apiKey };
      try {
        state.clients.delete(alias);
        await connectPortal(alias);
      } catch (err) {
        delete state.registry.portals[alias];
        return textResult(`Could not connect to ${url}: ${String(err)}`, true);
      }
      saveRegistry(state.registry);
      const entry = state.registry.portals[alias];
      const group = groupOf(entry.version);
      let note = "";
      if (state.boundGroup === null) {
        state.defaultPortal = alias;
        await bindGroup(group);
        await server.sendToolListChanged();
        note =
          "Session is now bound to this version group. If new portal tools do " +
          "not appear, restart the session with ZUAR_PORTAL=<alias> (or from a " +
          "pinned folder), or reconnect the MCP server " +
          "if the harness supports it (Claude Code: /mcp reconnect).";
      } else if (group !== state.boundGroup) {
        note =
          `Registered, but its group ${group} differs from the session group ` +
          `${state.boundGroup} — usable only from a session bound to ${group}.`;
      } else {
        state.upstreamTools = state.upstreamTools.map((t) =>
          injectPortalParam(t, groupAliases(group)),
        );
        await server.sendToolListChanged();
      }
      return textResult({
        registered: alias,
        version: entry.version ?? "unknown",
        group,
        note: note || undefined,
      });
    }

    case "remove_portal": {
      const alias = String(args.alias);
      const entry = state.registry.portals[alias];
      if (!entry) {
        return textResult(`unknown portal alias: ${alias}`, true);
      }
      const group = groupOf(entry.version);
      delete state.registry.portals[alias];
      const client = state.clients.get(alias);
      if (client) {
        state.clients.delete(alias);
        await client.close().catch(() => undefined);
      }
      if (state.defaultPortal === alias) state.defaultPortal = null;
      saveRegistry(state.registry);
      if (state.boundGroup === group) {
        const aliases = groupAliases(group);
        state.upstreamTools = state.upstreamTools.map((t) =>
          injectPortalParam(t, aliases),
        );
        await server.sendToolListChanged();
      }
      return textResult({ removed: alias });
    }

    case "use_portal": {
      const alias = String(args.alias);
      const entry = state.registry.portals[alias];
      if (!entry) return textResult(`unknown portal alias: ${alias}`, true);
      const group = groupOf(entry.version);
      if (state.boundGroup && group !== state.boundGroup) {
        return textResult(
          `Refused: ${alias} is version group ${group}, but this session is bound ` +
            `to ${state.boundGroup}. Portals of one session must share a version ` +
            `group — use a separate session for ${group}.`,
          true,
        );
      }
      state.defaultPortal = alias;
      if (state.boundGroup === null) {
        await bindGroup(group);
        await server.sendToolListChanged();
        return textResult({
          default_portal: alias,
          bound_group: group,
          note:
            "Session bound; portal tools were added. If they do not appear, " +
            "restart the session with ZUAR_PORTAL=<alias> (or from a " +
            "pinned folder), or reconnect the MCP server if " +
            "the harness supports it (Claude Code: /mcp reconnect).",
        });
      }
      return textResult({ default_portal: alias, bound_group: state.boundGroup });
    }

    default:
      return textResult(`unknown tool: ${name}`, true);
  }
}

function resolveTarget(args: Record<string, unknown>): string {
  const requested = typeof args.portal === "string" ? args.portal : null;
  if (requested) {
    const entry = state.registry.portals[requested];
    if (!entry) throw new Error(`unknown portal alias: ${requested}`);
    if (groupOf(entry.version) !== state.boundGroup) {
      throw new Error(
        `portal ${requested} is not in the session's version group ${state.boundGroup}`,
      );
    }
    return requested;
  }
  if (state.defaultPortal) return state.defaultPortal;
  const aliases = state.boundGroup ? groupAliases(state.boundGroup) : [];
  if (aliases.length === 1) return aliases[0];
  throw new Error(
    "several portals are connected and no default is set — pass the 'portal' " +
      "argument or call use_portal first",
  );
}

const server = new Server(
  { name: "zportal-client-mcp", version: CLIENT_MCP_VERSION },
  {
    capabilities: {
      tools: { listChanged: true },
      resources: { listChanged: true },
      prompts: { listChanged: true },
    },
    instructions:
      "Client MCP for Zuar Portal instances. One deduplicated tool surface " +
      "serves every connected portal of the session's version group; portal " +
      "tools take an optional 'portal' argument. Start with list_portals; " +
      "set a default with use_portal. Version-matched authoring guides are " +
      "MCP resources (zportal://skills/...).",
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  await bindingPromise.catch(() => undefined);
  return { tools: [...OWN_TOOLS, ...state.upstreamTools] };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  await bindingPromise.catch(() => undefined);
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  if (OWN_TOOLS.some((t) => t.name === name)) {
    return handleOwnTool(name, args);
  }
  try {
    const alias = resolveTarget(args);
    const { portal: _portal, ...forwarded } = args;
    return await withClient(alias, (c) =>
      c.callTool({ name, arguments: forwarded }),
    );
  } catch (err) {
    return textResult(String(err), true);
  }
});

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  await bindingPromise.catch(() => undefined);
  if (!state.boundGroup) return { resources: [] };
  return withRepresentative((c) => c.listResources());
});

function requireBinding(): void {
  if (!state.boundGroup) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "No portal connected: the session is not bound to a version group " +
        "yet — call use_portal or add_portal first.",
    );
  }
}

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  await bindingPromise.catch(() => undefined);
  requireBinding();
  return withRepresentative((c) => c.readResource({ uri: req.params.uri }));
});

server.setRequestHandler(ListPromptsRequestSchema, async () => {
  await bindingPromise.catch(() => undefined);
  if (!state.boundGroup) return { prompts: [] };
  return withRepresentative((c) => c.listPrompts());
});

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  await bindingPromise.catch(() => undefined);
  requireBinding();
  return withRepresentative((c) =>
    c.getPrompt({ name: req.params.name, arguments: req.params.arguments }),
  );
});

const transport = new StdioServerTransport();
await server.connect(transport);
// Upstream connections keep the event loop alive — exit on stdio close.
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
log(`router started (registry: ${Object.keys(state.registry.portals).length} portals)`);
