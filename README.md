# zportal plugin — Client MCP

Claude Code plugin bundling the **Client MCP**: a local stdio server
that exposes one deduplicated tool surface for many Zuar Portal
instances and proxies every call to the right instance's **Portal
MCP** with that instance's API key. Architecture and terminology:
`usr-dev/docs/product/portal/features/Client-MCP.md`.

Requires Portal ≥ 1.21 (the first release shipping a Portal MCP);
older portals are not supported.

## Layout

- `.claude-plugin/plugin.json` — plugin manifest (name `zportal` →
  commands are namespaced `/zportal:...`).
- `.mcp.json` — registers the bundled Client MCP as server `zportal-client-mcp`
  (`node client-mcp/dist/index.js`).
- `skills/` — thin version-agnostic skills; version-specific guidance
  is served by portals as MCP resources (`zportal://skills/...`).
- `client-mcp/` — the Client MCP (TypeScript, stdio): portal
  registry, version groups, eager binding, tool dedup + `portal`
  enum param, proxying, upstream reconnection.

## Install (team)

The repo is its own plugin marketplace. In Claude Code:

```
/plugin marketplace add zuarbase/portal-client-mcp
/plugin install zportal@zuar
```

Private-repo access uses your normal git credentials (SSH by
default). Installs come from the `release` branch, which CI
publishes on every `v*` tag: self-contained bundled server
(`client-mcp/dist/index.js`, no node_modules needed) + versions
stamped from the tag. `main` carries sources only.

To preconfigure the whole team, add to the portal monorepo's
`.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "zuar": {
      "source": {"source": "github", "repo": "zuarbase/portal-client-mcp"}
    }
  },
  "enabledPlugins": {"zportal@zuar": true}
}
```

## Making changes: from edit to users

1. **Develop.** Edit, then:

   ```bash
   cd client-mcp && npm install && npm test
   ```

   `npm test` rebuilds (`tsc`) and runs the suite against fake
   Portal MCP instances spun up in-process
   (`test/fixture-portal.mjs`) — no external services. Skill and
   manifest edits need no build at all.

2. **Check by hand** (optional):

   ```bash
   claude --plugin-dir <path-to-this-repo>
   ```

   In an already-running session: rebuild if you skipped `npm test`,
   then `/reload-plugins`.

3. **Land it.** Commit to `main` (or branch + PR); CI runs the suite
   on ubuntu/macos/windows.

4. **Release** when the change should reach plugin users:

   ```bash
   git tag v0.3.0 && git push origin v0.3.0
   ```

   The tag IS the version — never bump versions by hand.
   `release.yml` then: tests → self-contained esbuild bundle →
   stamps the tag version into `client-mcp/package.json` and
   `.claude-plugin/plugin.json` → force-pushes the `release` branch
   (single commit; old blobs are GC'd, so history never grows). At
   runtime `serverInfo.version` is read from `package.json`, with a
   `0.0.0-dev` fallback outside packaged artifacts.

5. **Users update** via `/plugin marketplace update zuar` (or
   marketplace auto-update) and a session restart /
   `/reload-plugins`.

Mind the asymmetry: marketplace installs come from the `release`
branch — pushes to `main` alone never reach users; your local
`--plugin-dir` is the opposite — it sees the working tree and needs
no tags, only a fresh `dist/`.

## Registering portals

In-session (Claude Code): `/zportal:connect` or the `add_portal`
tool. Outside a session (required for Codex, which cannot refresh
MCP tools mid-session):

```bash
node client-mcp/dist/index.js add acme https://acme.example.com/mcp/ <api-key>
node client-mcp/dist/index.js list
node client-mcp/dist/index.js remove acme
```

Registry: `~/.zuar/portals.json` (override: `ZUAR_PORTAL_REGISTRY`),
written with mode 600. Keychain/Credential Manager storage is
planned; the file is the interim store.

## Session binding

One session = one portal version group (`major.minor`). Eager
binding at startup, in priority order:

1. explicit portal — `--portal <alias>` server arg or `ZUAR_PORTAL`
   env var (works from any directory; the way to go for Codex):
   `ZUAR_PORTAL=acme codex`
2. cwd pin — `.zuar-portal/config.json` with
   `{"default_portal": "<alias>"}`, searched upward from cwd
   (optional "folder per customer" convenience);
3. a registry where all portals share one version group.

Unbound sessions expose only the Client MCP's own tools
(`list_portals`, `add_portal`, `use_portal`, `remove_portal`); the
first `use_portal` binds the session and emits `tools/list_changed`
— Claude Code picks it up mid-session, Codex does not (verified
2026-07): restart the session with an explicit portal instead.

## Known gaps (deliberate, tracked for productization)

- API key passes through the conversation in `/zportal:connect`
  (production: loopback form so the key never enters the model).
- Keys in a plain config file (mode 600); keychain later.
- No cross-instance schema hash verification within a group yet.
- No write binding-gate beyond the version group check.
- Upstream restart resilience is evict-reconnect-retry-once: a write
  whose response was lost may execute twice (verify-and-adopt
  deferred).
