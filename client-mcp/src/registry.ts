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
}

const registryPath =
  process.env.ZUAR_PORTAL_REGISTRY ??
  path.join(os.homedir(), ".zuar", "portals.json");

export function loadRegistry(): Registry {
  try {
    const raw = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    if (raw && typeof raw.portals === "object") return raw;
  } catch {
    // missing or unreadable file → empty registry
  }
  return { portals: {} };
}

export function saveRegistry(reg: Registry): void {
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
