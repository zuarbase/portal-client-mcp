import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface PortalEntry {
  url: string;
  apiKey: string;
  version?: string;
}

export interface Registry {
  portals: Record<string, PortalEntry>;
  /** Provided by the environment for this process; never persisted. */
  ephemeral?: boolean;
}

const registryPath =
  process.env.ZUAR_PORTAL_REGISTRY ??
  path.join(os.homedir(), ".zuar", "portals.json");

/** Alias for the env-provided portal when none is named. */
const ENV_PORTAL_ALIAS = "portal";

/**
 * One portal handed over by the environment, for callers that cannot
 * answer prompts and must not write a key to disk — a test-harness
 * run, a CI job. The registration file such a caller writes can then
 * reference the credential by env var name, holding no secret itself.
 */
function envRegistry(): Registry | null {
  const url = process.env.ZUAR_PORTAL_URL?.trim();
  if (!url) return null;
  const apiKey = process.env.ZUAR_PORTAL_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "ZUAR_PORTAL_URL is set without ZUAR_PORTAL_API_KEY: the " +
        "portal to use is known but there is no key to reach it with.",
    );
  }
  const alias = process.env.ZUAR_PORTAL?.trim() || ENV_PORTAL_ALIAS;
  return {
    portals: { [alias]: { url: normalizePortalUrl(url), apiKey } },
    ephemeral: true,
  };
}

export function loadRegistry(): Registry {
  const fromEnv = envRegistry();
  // The env portal replaces the file rather than adding to it: a
  // headless run gets exactly the portal it was given, with nothing
  // inherited from whoever's home directory it happens to run in.
  if (fromEnv) return fromEnv;
  try {
    const raw = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    if (raw && typeof raw.portals === "object") return raw;
  } catch {
    // missing or unreadable file → empty registry
  }
  return { portals: {} };
}

export function saveRegistry(reg: Registry): void {
  if (reg.ephemeral) return;
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify(reg, null, 2) + "\n", {
    mode: 0o600,
  });
}

/**
 * Walk up from cwd looking for .zuar-portal/config.json with a
 * default_portal alias — the "folder per customer" pin.
 */
export function findCwdPin(startDir: string = process.cwd()): string | null {
  let dir = startDir;
  for (;;) {
    const p = path.join(dir, ".zuar-portal", "config.json");
    if (fs.existsSync(p)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
        if (typeof cfg.default_portal === "string") {
          return cfg.default_portal;
        }
      } catch {
        // unreadable pin file — ignore and keep walking up
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Version group = major.minor of the portal version. */
export function groupOf(version: string | undefined): string {
  if (!version) return "unknown";
  const m = version.match(/^(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : version;
}

/** Where zwaf's generic /services/<name>/ proxy exposes the Portal MCP. */
const MCP_ENDPOINT_PATH = "/services/portal-mcp/mcp";

/**
 * Normalize what an admin typed into a valid absolute URL, changing
 * nothing else. This is what the registry stores: the endpoint path
 * is derived at connect time (`mcpEndpointUrl`), so the path
 * convention lives in code shipped with the plugin — not baked into
 * every registry on every machine.
 */
export function normalizePortalUrl(input: string): string {
  const trimmed = input.trim();
  const url = new URL(
    /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`,
  );
  return url.toString();
}

/**
 * Turn a stored portal URL into the MCP endpoint to connect to. A
 * URL that already carries a path is taken as given, so a
 * non-standard deployment can still be registered verbatim.
 */
export function mcpEndpointUrl(portalUrl: string): string {
  const url = new URL(normalizePortalUrl(portalUrl));
  if (url.pathname === "/" || url.pathname === "") {
    url.pathname = MCP_ENDPOINT_PATH;
  }
  return url.toString();
}
