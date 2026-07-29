---
description: Connect a Zuar Portal instance to this session — register its URL and API key with the Client MCP
disable-model-invocation: true
---

# Connect a portal

Register a Zuar Portal instance with the Client MCP.

1. Ask the user for:
   - the portal's URL, e.g. `https://acme.example.com` (the MCP
     endpoint path is appended automatically),
   - a short alias (suggest one from the hostname),
   - an admin API key (created in Portal UI under Auth → API keys).
2. Call the `add_portal` tool with `alias`, `url`, `api_key`.
3. Report the detected portal version and version group. If the
   session is already bound to a different version group, tell the
   user this portal is registered but only usable from a session
   bound to its own group.

Note: this flow passes the API key through the conversation. A local
loopback form (key never enters the model context) is planned but
not implemented yet; until then, suggest the CLI alternative for
sensitive environments:
`node <plugin>/client-mcp/dist/index.js add <alias> <url> <api_key>`.
