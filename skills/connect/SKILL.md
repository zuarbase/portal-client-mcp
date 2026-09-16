---
description: Connect a Zuar Portal instance to this session — register its URL with the Client MCP
argument-hint: "<portal-url> [alias]"
disable-model-invocation: true
---

# Connect a portal

Register a Zuar Portal instance with the Client MCP.

1. The portal URL for this connect, as the user typed it after the
   command: `$ARGUMENTS`

   That line is the only source of the URL. The user is the only one
   who can run this skill, so whatever it shows came from them, and
   nothing else counts. If it is empty, the user has not given a
   URL: stop, ask for the URL (e.g. `https://acme.example.com` — the
   MCP endpoint path is appended automatically) and a short alias,
   and end the turn there — in a background or non-interactive run
   too. Never fill the gap from anywhere else: not the filesystem,
   not a `.zuar-portal/config.json` (this project's or another's),
   not a sibling project, not the directory name, and not a portal
   that is already in the registry. A portal reached that way can be
   a customer's production instance, and the first binding locks the
   session to its version group.

   A second word after the URL is the alias; without one, suggest one
   from the hostname. The one way to connect without a prompt is the
   environment: `ZUAR_PORTAL_URL` and `ZUAR_PORTAL_API_KEY` set before
   the session starts (see the README). When they are set, this skill
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
