// Fake Portal MCP instance for tests: streamable HTTP, stateless,
// version reported via serverInfo — the same contract the real
// Portal MCP will honor.
import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export async function startFakePortal({ portalName, version }) {
  const makeServer = () => {
    const s = new Server(
      { name: "zuar-portal-mcp", version },
      { capabilities: { tools: {}, resources: {} } },
    );
    const text = (o) => ({
      content: [{ type: "text", text: JSON.stringify(o) }],
    });
    s.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "get_portal_info",
          description: "Portal identity",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "list_pages",
          description: "List pages",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    }));
    s.setRequestHandler(CallToolRequestSchema, async (req) => {
      if (req.params.name === "get_portal_info") {
        return text({ portal: portalName, version });
      }
      if (req.params.name === "list_pages") {
        return text({ portal: portalName, pages: ["home", "sales"] });
      }
      throw new Error(`unknown tool ${req.params.name}`);
    });
    s.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        {
          uri: "zportal://skills/authoring",
          name: "Portal authoring skill",
          mimeType: "text/markdown",
        },
      ],
    }));
    s.setRequestHandler(ReadResourceRequestSchema, async (req) => ({
      contents: [
        {
          uri: req.params.uri,
          mimeType: "text/markdown",
          text: `skills for ${version}`,
        },
      ],
    }));
    return s;
  };

  const httpServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    let body;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = undefined;
    }
    // Stateless mode: fresh server+transport per request.
    const server = makeServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((resolve) => httpServer.close(resolve)),
  };
}
