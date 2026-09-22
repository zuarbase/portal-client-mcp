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
    return readRegistryFile();
  } catch {
    // unreadable file → empty registry for reading
    return { portals: {} };
  }
}

/**
 * Pick up what other sessions wrote to the file since this one last
 * looked. Several sessions share one registry, so an in-memory copy
 * taken at process start goes stale as soon as another one connects
 * or removes a portal.
 */
export function refreshRegistry(reg: Registry): void {
  if (reg.ephemeral) return;
  try {
    reg.portals = readRegistryFile().portals;
  } catch (err) {
    // A half-written or hand-broken file: keep what we have rather
    // than forget every portal until the next successful read.
    process.stderr.write(
      `[zportal-client-mcp] registry not refreshed: ${String(err)}\n`,
    );
  }
}

/**
 * Apply one change to the registry — in memory and on disk. The disk
 * side re-reads the file and applies the change to that, so entries
 * other sessions wrote since this one started are kept rather than
 * overwritten by this process's snapshot. `change` runs once against
 * each copy, so it must only set or delete the entries it is about.
 */
export function updateRegistry(
  reg: Registry,
  change: (portals: Record<string, PortalEntry>) => void,
): void {
  change(reg.portals);
  if (reg.ephemeral) return;
  // A file that exists but cannot be parsed throws here: writing our
  // one change over it would wipe every other entry and its key.
  const onDisk = readRegistryFile();
  change(onDisk.portals);
  writeRegistryFile(onDisk);
}

/** The registry file as it is now; empty if it does not exist yet. */
function readRegistryFile(): Registry {
  let text: string;
  try {
    text = fs.readFileSync(registryPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { portals: {} };
    }
    throw err;
  }
  const raw = JSON.parse(text);
  if (!raw || typeof raw.portals !== "object" || raw.portals === null) {
    throw new Error(`${registryPath} has no "portals" object`);
  }
  return raw;
}

/**
 * Write via a temp file and rename, so a session reading at the same
 * moment sees the old file or the new one, never half of one.
 */
function writeRegistryFile(reg: Registry): void {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  const tmp = `${registryPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, registryPath);
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
