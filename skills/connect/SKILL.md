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

   The URL comes from the user, in this conversation, or this step
   is not done. If the user has not given one, stop, ask, and end
   the turn there — in a background or non-interactive run too.
   Never take the URL from anywhere else: not the filesystem, not a
   `.zuar-portal/config.json` (this project's or another's), not a
   sibling project, not the directory name, and not a portal that
   is already in the registry. A portal reached that way can be a
   customer's production instance, and the first binding locks the
   session to its version group.

   The one way to connect without a prompt is the environment:
   `ZUAR_PORTAL_URL` and `ZUAR_PORTAL_API_KEY` set before the
   session starts (see the README). When they are set, this skill
   is not needed and `connect_portal` refuses.
2. Call the `connect_portal` tool with `alias` and `url`. It opens a
   form in the user's browser where they enter the admin API key
   (Portal UI → Auth → API keys). **Never ask for the key here** —
   it must not pass through the conversation, and there is no tool
   parameter for it.
3. Report the detected portal version and version group. If the
   session is already bound to a different version group, tell the
   user this portal is registered but only usable from a session
   bound to its own group.
