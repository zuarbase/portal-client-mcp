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
  is served by each portal through its `get_skill` tool.
- `client-mcp/` — the Client MCP (TypeScript, stdio): portal
  registry, version groups, eager binding, tool dedup + `portal`
  enum param, proxying, upstream reconnection.

## Install (team)

The repo is its own plugin marketplace. In Claude Code:

```
/plugin marketplace add zuarbase/zuar-portal-mcp-plugin
/plugin install zportal@zuar-portal
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
      "source": {"source": "github", "repo": "zuarbase/zuar-portal-mcp-plugin"}
    }
  },
  "enabledPlugins": {"zportal@zuar-portal": true}
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
   runtime `serverInfo.version` is read from `package.json`. On
   `main` both manifests say `0.0.0-dev`, so a checkout or
   `--plugin-dir` run reports a development build, never a release
   it is not; `client-mcp/test/version.test.mjs` guards that.

5. **Users update** via `/plugin marketplace update zuar` (or
   marketplace auto-update) and a session restart /
   `/reload-plugins`.

Mind the asymmetry: marketplace installs come from the `release`
branch — pushes to `main` alone never reach users; your local
`--plugin-dir` is the opposite — it sees the working tree and needs
no tags, only a fresh `dist/`.

## Registering portals

In-session (Claude Code): `/zportal:connect`, or the
`connect_portal` tool directly. Both open a form on loopback where
the admin types the API key, so **the key never passes through the
conversation** — there is no tool parameter for it.

Outside a session (required for Codex, which cannot refresh MCP
tools mid-session) — the bundle is self-contained, so one downloaded
file is the whole CLI, no clone or npm install:

```bash
gh release download -R zuarbase/zuar-portal-mcp-plugin -p zportal.js
node zportal.js connect acme https://acme.example.com   # same form
node zportal.js add acme https://acme.example.com <key> # scripted
node zportal.js list
node zportal.js remove acme
```

`connect` keeps the key out of shell history too; `add` takes it as
an argument for scripted setup, where the operator has chosen where
the secret comes from.

(From a working clone, `node client-mcp/dist/index.js` is the same
binary.)

Registry: `~/.zuar/portals.json` (override: `ZUAR_PORTAL_REGISTRY`),
written with mode 600. Keychain/Credential Manager storage is
planned; the file is the interim store.

## Headless runs (test harness, CI)

A caller that cannot answer prompts and must not leave a key on disk
hands the portal over in the environment instead:

```bash
ZUAR_PORTAL_URL=https://acme.example.com \
ZUAR_PORTAL_API_KEY=<key> \
  claude -p "..." --mcp-config mcp-config.json
```

That portal *replaces* the file registry for the process, so a run
gets exactly the portal it was given and inherits nothing from
whatever home directory it lands in. The session is bound to it from
the first `tools/list` — no registration step, no unbound window.
Nothing is written to disk, and `connect_portal` / `remove_portal` refuse
with an explanation rather than half-working.

`ZUAR_PORTAL` names the alias if the caller cares what it is
called (it shows up in tool arguments and reports); the default is
`portal`. `ZUAR_PORTAL_URL` without `ZUAR_PORTAL_API_KEY` is a setup
error and the server exits — a run must fail loudly at launch rather
than after burning an agent turn.

**The registration file holds no secret.** Credentials reach the
server through the environment the caller already controls, so
`mcp-config.json` is just:

```json
{
  "mcpServers": {
    "zportal-client-mcp": {
      "command": "node",
      "args": ["/path/to/zportal.js"]
    }
  }
}
```

It is therefore safe to keep alongside run results.

## Session binding

One session = one portal version group (`major.minor`). Eager
binding at startup, in priority order:

1. explicit portal — `--portal <alias>` server arg, `ZUAR_PORTAL`
   env var (works from any directory; the way to go for Codex):
   `ZUAR_PORTAL=acme codex` — or the portal supplied entirely by the
   environment (see headless runs above);
2. cwd pin — `.zuar-portal/config.json` with
   `{"default_portal": "<alias>"}`, searched upward from cwd
   (optional "folder per customer" convenience);
3. a registry where all portals share one version group.

Unbound sessions expose only the Client MCP's own tools
(`list_portals`, `connect_portal`, `use_portal`, `remove_portal`); the
first `use_portal` binds the session and emits `tools/list_changed`
— Claude Code picks it up mid-session, Codex does not (verified
2026-07): restart the session with an explicit portal instead.

## Known gaps (deliberate, tracked for productization)

- Keys in a plain config file (mode 600); keychain later.
- No cross-instance schema hash verification within a group yet.
- No write binding-gate beyond the version group check.
- Upstream transport failures carry their cause in the error text
  (`TypeError: fetch failed (ECONNRESET: socket hang up)`). A call is
  repeated on a fresh connection only when the request provably never
  left: connection refused, host unresolvable, or a failed handshake,
  up to three attempts. A connection that broke after the call was
  sent may have delivered it, so the call is not repeated, read or
  write; the client does not know which tools write, and one extra
  round trip for the agent is cheaper than that contract. The error
  says the request may have been delivered and names the check to run
  before repeating a write (`list_change_sets` for the entity, or
  `list_entities` by name after a `create_entity`). Pooled sockets are
  bypassed for a minute after any failure. The client does not run that
  check itself (verify-and-adopt still deferred).
