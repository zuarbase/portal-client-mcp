---
description: Building, modifying, or inspecting Zuar Portal content (pages, blocks, charts, themes, queries, datasources) through the Portal MCP tools. Use whenever the user asks to create, edit, review, or clean up content on any Zuar Portal instance.
---

# Zuar Portal authoring

You are working against one or more Zuar Portal instances through the
`zportal` MCP server (the Client MCP). It exposes a single tool set; every portal tool
accepts an optional `portal` argument selecting the target instance.

## Before any work

1. If more than one portal is connected (`list_portals`), confirm with
   the user which portal the task targets. Never guess the target for
   a write.
2. Read the version-matched guide from the MCP resource
   `zportal://skills/authoring` and follow the workflow described
   there. Topic guides (`zportal://skills/charts`, `.../blocks`,
   `.../layout`, `.../theming`, `.../data-binding`) cover specifics —
   read the relevant one before working in that area. If the portal
   publishes no such resources (older or in-development builds),
   say so and proceed with extra caution.

## Invariant safety rules

These hold on every portal version:

- Before destructive or bulk changes, make sure a rollback point
  exists. If the portal provides snapshot tools, use them; if it
  does not, tell the user there is no rollback path and get explicit
  confirmation before proceeding.
- For multi-portal fan-out ("copy this to portals A, B, C…"),
  confirm the full target list once, then process portals one at a
  time and report per-portal success or failure — never stop
  silently halfway.
- Never guess data shapes, theme values, or block configuration —
  read them with the tools (profiling, theme reads, block-type
  registry) before building.
- Prefer minimal targeted updates over re-emitting whole entities.
- Use `dry_run` where a write tool offers it before the real write.
- After building or changing content, verify with the portal's
  validation tool before reporting success.
