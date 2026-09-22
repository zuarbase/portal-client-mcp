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
  ConnectFormError,
  openBrowser,
  requestApiKey,
} from "./connect-form.js";
import {
  findCwdPin,
  groupOf,
  loadRegistry,
  mcpEndpointUrl,
  normalizePortalUrl,
  refreshRegistry,
  updateRegistry,
  type PortalEntry,
  type Registry,
} from "./registry.js";
import {
  AmbiguousDeliveryError,
  ambiguousDeliveryMessage,
  classifyTransportFailure,
  describeError,
  noteConnectionFailure,
  pooledSocketsSuspect,
} from "./transport-errors.js";

// Version source: package.json. main carries 0.0.0-dev; CI stamps the tag
// version into the release branch, so only a release reports a number.
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
  /** The aliases the upstream tools' 'portal' enum currently offers. */
  portalAliases: string[];
}

const state: SessionState = {
  registry: loadRegistry(),
  boundGroup: null,
  defaultPortal: null,
  clients: new Map(),
  upstreamTools: [],
  portalAliases: [],
};

function log(msg: string): void {
  process.stderr.write(`[zportal-client-mcp] ${msg}\n`);
}

/** The url and key each cached client was opened with. */
const clientTargets = new WeakMap<Client, string>();

function targetOf(entry: PortalEntry): string {
  return `${entry.url}\n${entry.apiKey}`;
}

async function connectPortal(alias: string): Promise<Client> {
  const cached = state.clients.get(alias);
  if (cached) return cached;
  const entry = state.registry.portals[alias];
  if (!entry) throw new Error(`unknown portal alias: ${alias}`);
  const client = new Client({ name: "zportal-client-mcp", version: CLIENT_MCP_VERSION });
  const headers: Record<string, string> = { Authorization: `Bearer ${entry.apiKey}` };
  if (pooledSocketsSuspect()) {
    // After a VPN flap, fetch's keep-alive pool keeps handing out sockets
    // that are already dead. Asking the portal to close each connection
    // once it has answered keeps every socket out of the pool while the
    // cooldown lasts, so the retries in withClient reach the portal on
    // fresh ones. A request header rather than an undici Agent with
    // keep-alive off: Node does not expose undici's Agent, and adding the
    // undici package would break the self-contained bundle.
    headers.Connection = "close";
  }
  const transport = new StreamableHTTPClientTransport(
    new URL(mcpEndpointUrl(entry.url)),
    { requestInit: { headers } },
  );
  await client.connect(transport);
  const serverVersion = client.getServerVersion()?.version;
  if (serverVersion && entry.version !== serverVersion) {
    entry.version = serverVersion;
    try {
      updateRegistry(state.registry, (portals) => {
        if (portals[alias]) portals[alias].version = serverVersion;
      });
    } catch (err) {
      // The version is a cache of what the portal reports; failing to
      // store it must not fail the connection that learned it.
      log(`could not record ${alias} version: ${describeError(err)}`);
    }
  }
  clientTargets.set(client, targetOf(entry));
  state.clients.set(alias, client);
  return client;
}

function groupAliases(group: string): string[] {
  return Object.entries(state.registry.portals)
    .filter(([, e]) => groupOf(e.version) === group)
    .map(([alias]) => alias)
    .sort();
}

const MAX_ATTEMPTS = 3;

/** Drop the cached client for `alias` and close it. */
async function evictClient(alias: string, client: Client | null): Promise<void> {
  state.clients.delete(alias);
  if (client) await client.close().catch(() => undefined);
}

/**
 * Run `fn` against the portal's cached client, reconnecting on a fresh
 * socket when the transport fails. Only a failure whose request
 * provably never left this process is repeated: connection refused,
 * host unresolvable, or a failed handshake, which never carries the
 * call. That needs no knowledge of the tool. A connection that broke
 * after the call was sent may have delivered it, so the call is not
 * repeated, whatever the tool: it surfaces as AmbiguousDeliveryError
 * and the caller decides. Anything the portal itself answered (a
 * protocol error, a tool refusal, an HTTP status error) is passed
 * through untouched. MAX_ATTEMPTS in total.
 */
async function withClient<T>(alias: string, fn: (c: Client) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    let client: Client | null = null;
    try {
      client = await connectPortal(alias);
      return await fn(client);
    } catch (err) {
      const failure = classifyTransportFailure(err);
      if (failure === "not-transport") throw err;
      noteConnectionFailure();
      const neverSent = client === null || failure === "never-sent";
      const retry = neverSent && attempt < MAX_ATTEMPTS;
      log(
        `call to ${alias} failed (${describeError(err)}), ` +
          (retry ? `reconnecting (attempt ${attempt + 1} of ${MAX_ATTEMPTS})` : "giving up"),
      );
      await evictClient(alias, client);
      if (!retry) throw neverSent ? err : new AmbiguousDeliveryError(err);
    }
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
      log(`representative ${alias} unreachable: ${describeError(err)}`);
    }
  }
  throw new Error(
    `no reachable portal in group ${state.boundGroup}: ${describeError(lastError)}`,
  );
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

/**
 * Bring the session in line with the registry, which other sessions
 * share and change: close clients for portals that were removed or
 * re-registered with another url or key, forget a default that is
 * gone, and rebuild the upstream tools' 'portal' enum. Returns whether
 * the enum changed, so a caller outside tools/list can tell the host.
 */
async function syncWithRegistry(): Promise<boolean> {
  for (const [alias, client] of state.clients) {
    const entry = state.registry.portals[alias];
    if (!entry || clientTargets.get(client) !== targetOf(entry)) {
      await evictClient(alias, client);
    }
  }
  if (state.defaultPortal && !state.registry.portals[state.defaultPortal]) {
    state.defaultPortal = null;
  }
  if (!state.boundGroup) return false;
  const aliases = groupAliases(state.boundGroup);
  if (aliases.join("\n") === state.portalAliases.join("\n")) return false;
  state.upstreamTools = state.upstreamTools.map((t) =>
    injectPortalParam(t, aliases),
  );
  state.portalAliases = aliases;
  return true;
}

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
          // An empty enum admits no value and is invalid under older
          // JSON Schema drafts, which can make a host reject the whole
          // tool list — so a group with no portals left gets none.
          ...(aliases.length > 0 ? { enum: aliases } : {}),
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
  state.portalAliases = aliases;
  log(`bound to version group ${group} (${aliases.join(", ")}), ${tools.length} upstream tools`);
}

/**
 * Explicit session target: `--portal <alias>` argv, ZUAR_PORTAL env,
 * or the single portal the environment supplied — a headless caller
 * that named a portal must never start unbound.
 */
function explicitPortal(): string | null {
  const idx = process.argv.indexOf("--portal");
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  if (process.env.ZUAR_PORTAL) return process.env.ZUAR_PORTAL;
  if (state.registry.ephemeral) {
    return Object.keys(state.registry.portals)[0] ?? null;
  }
  return null;
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
      log(`bind to ${alias} failed: ${describeError(err)}`);
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
        log(`single-group bind failed: ${describeError(err)}`);
      }
    }
  }
}

/**
 * CLI registry management (`add`/`list`/`remove`) — sessions start
 * pre-populated, since Codex can't refresh tools mid-session.
 */
const ENV_PROVIDED_MESSAGE =
  "This session's portal comes from ZUAR_PORTAL_URL, so the registry " +
  "is fixed for the process and cannot be changed from inside it.";

async function registerPortal(
  alias: string,
  url: string,
  apiKey: string,
): Promise<number> {
  const entry: PortalEntry = { url: normalizePortalUrl(url), apiKey };
  state.registry.portals[alias] = entry;
  try {
    await connectPortal(alias);
  } catch (err) {
    delete state.registry.portals[alias];
    console.error(
      `could not connect to ${mcpEndpointUrl(url)}: ${describeError(err)}`,
    );
    return 1;
  }
  updateRegistry(state.registry, (portals) => {
    portals[alias] = entry;
  });
  console.log(
    JSON.stringify(
      {
        registered: alias,
        version: entry.version,
        group: groupOf(entry.version),
      },
      null,
      2,
    ),
  );
  return 0;
}

async function runCli(cmd: string, rest: string[]): Promise<number> {
  if (cmd !== "list" && state.registry.ephemeral) {
    console.error(ENV_PROVIDED_MESSAGE);
    return 2;
  }
  if (cmd === "list") {
    console.log(JSON.stringify(portalSummary(), null, 2));
    return 0;
  }
  if (cmd === "connect") {
    const [alias, url] = rest;
    if (!alias || !url) {
      console.error("usage: index.js connect <alias> <portal_url>");
      return 2;
    }
    let apiKey: string;
    try {
      apiKey = await collectApiKey(normalizePortalUrl(url), alias);
    } catch (err) {
      console.error(describeError(err));
      return 1;
    }
    return registerPortal(alias, url, apiKey);
  }
  if (cmd === "add") {
    const [alias, url, apiKey] = rest;
    if (!alias || !url || !apiKey) {
      console.error("usage: index.js add <alias> <portal_url> <api_key>");
      return 2;
    }
    return registerPortal(alias, url, apiKey);
  }
  if (cmd === "remove") {
    const [alias] = rest;
    if (!alias || !state.registry.portals[alias]) {
      console.error(`unknown portal alias: ${alias}`);
      return 1;
    }
    updateRegistry(state.registry, (portals) => {
      delete portals[alias];
    });
    console.log(JSON.stringify({ removed: alias }));
    return 0;
  }
  console.error(
    `unknown command: ${cmd}\n` +
      "usage: index.js [connect <alias> <url> | add <alias> <url> <api_key>\n" +
      "                 | list | remove <alias>]\n" +
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
    name: "connect_portal",
    description:
      "Register a Zuar Portal instance. Opens a form in the user's browser " +
      "where they enter the admin API key: the key goes straight to this " +
      "client and is never a tool argument. Detects the portal version. " +
      "Binds the session to the portal's version group if the session is still unbound.",
    inputSchema: {
      type: "object",
      properties: {
        alias: { type: "string", description: "Short name, e.g. 'acme'" },
        url: {
          type: "string",
          description:
            "The portal's URL, e.g. https://acme.example.com — the MCP " +
            "endpoint path is appended automatically.",
        },
      },
      required: ["alias", "url"],
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


/** Ask for the key in a browser form; the model never sees it. */
async function collectApiKey(url: string, alias: string): Promise<string> {
  let formUrl = "";
  const key = requestApiKey({
    portalUrl: url,
    alias,
    onReady: (u) => {
      formUrl = u;
      log(`key form for ${alias}: ${u}`);
    },
  });
  // Give listen() a tick so the URL exists before we launch a browser.
  await new Promise((r) => setTimeout(r, 0));
  if (formUrl && !(await openBrowser(formUrl))) {
    log(`could not open a browser; open ${formUrl} to continue`);
  }
  return key;
}

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

    case "connect_portal": {
      if (state.registry.ephemeral) {
        return textResult(ENV_PROVIDED_MESSAGE, true);
      }
      const alias = String(args.alias);
      const url = normalizePortalUrl(String(args.url));
      let apiKey: string;
      try {
        apiKey = await collectApiKey(url, alias);
      } catch (err) {
        return textResult(
          err instanceof ConnectFormError
            ? `Nothing was registered: ${err.message}.`
            : `Could not open the key form: ${describeError(err)}`,
          true,
        );
      }
      const entry: PortalEntry = { url, apiKey };
      state.registry.portals[alias] = entry;
      try {
        await evictClient(alias, state.clients.get(alias) ?? null);
        await connectPortal(alias);
      } catch (err) {
        delete state.registry.portals[alias];
        return textResult(`Could not connect to ${url}: ${describeError(err)}`, true);
      }
      updateRegistry(state.registry, (portals) => {
        portals[alias] = entry;
      });
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
      } else if (await syncWithRegistry()) {
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
      if (state.registry.ephemeral) {
        return textResult(ENV_PROVIDED_MESSAGE, true);
      }
      const alias = String(args.alias);
      const entry = state.registry.portals[alias];
      if (!entry) {
        return textResult(`unknown portal alias: ${alias}`, true);
      }
      updateRegistry(state.registry, (portals) => {
        delete portals[alias];
      });
      if (await syncWithRegistry()) await server.sendToolListChanged();
      return textResult({ removed: alias });
    }

    case "use_portal": {
      const alias = String(args.alias);
      const entry = state.registry.portals[alias];
      if (!entry) return textResult(`unknown portal alias: ${alias}`, true);
      if (!entry.version) {
        // Its group is its version, and a registry entry can predate
        // ever having reached the portal — ask it before deciding.
        try {
          await connectPortal(alias);
        } catch (err) {
          return textResult(
            `Could not reach ${alias}: ${describeError(err)}`,
            true,
          );
        }
      }
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
  if (aliases.length === 0) {
    throw new Error(
      state.boundGroup
        ? `no portal of version group ${state.boundGroup} is registered any ` +
            "more — connect one with connect_portal"
        : "no portal connected — call use_portal or connect_portal first",
    );
  }
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
      "set a default with use_portal. Version-matched skills are served " +
      "by each portal's get_skill tool.",
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  await bindingPromise.catch(() => undefined);
  // The host is asking for the list: no need to tell it it changed.
  refreshRegistry(state.registry);
  await syncWithRegistry();
  return { tools: [...OWN_TOOLS, ...state.upstreamTools] };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  await bindingPromise.catch(() => undefined);
  refreshRegistry(state.registry);
  if (await syncWithRegistry()) await server.sendToolListChanged();
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  if (OWN_TOOLS.some((t) => t.name === name)) {
    return handleOwnTool(name, args);
  }
  const { portal: _portal, ...forwarded } = args;
  let alias = "";
  try {
    alias = resolveTarget(args);
    return await withClient(alias, (c) => c.callTool({ name, arguments: forwarded }));
  } catch (err) {
    if (err instanceof AmbiguousDeliveryError) {
      return textResult(ambiguousDeliveryMessage(name, alias, forwarded, err.cause), true);
    }
    return textResult(describeError(err), true);
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
