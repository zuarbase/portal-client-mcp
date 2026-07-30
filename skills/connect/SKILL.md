---
description: Connect a Zuar Portal instance to this session — register its URL with the Client MCP
disable-model-invocation: true
---

# Connect a portal

Register a Zuar Portal instance with the Client MCP.

1. Ask the user for:
   - the portal's URL, e.g. `https://acme.example.com` (the MCP
     endpoint path is appended automatically),
   - a short alias (suggest one from the hostname).
2. Call the `connect_portal` tool with `alias` and `url`. It opens a
   form in the user's browser where they enter the admin API key
   (Portal UI → Auth → API keys). **Never ask for the key here** —
   it must not pass through the conversation, and there is no tool
   parameter for it.
3. Report the detected portal version and version group. If the
   session is already bound to a different version group, tell the
   user this portal is registered but only usable from a session
   bound to its own group.
