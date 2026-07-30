import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as http from "node:http";

const DEFAULT_TIMEOUT_MS = 180_000;

export class ConnectFormError extends Error {}

function page(body: string): string {
  return `<!doctype html><meta charset="utf-8">
<title>Connect a Zuar Portal</title>
<style>
 body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;
      place-items:center;min-height:100vh;background:#f6f7f9;color:#1c1e21}
 main{background:#fff;padding:2rem 2.25rem;border-radius:10px;
      box-shadow:0 1px 4px rgba(0,0,0,.12);max-width:26rem;width:100%}
 h1{font-size:1.1rem;margin:0 0 1.25rem}
 dl{margin:0 0 1.25rem;font-size:.9rem;color:#4b4f56}
 dt{font-weight:600} dd{margin:0 0 .5rem}
 label{display:block;font-weight:600;margin-bottom:.4rem}
 input{width:100%;padding:.55rem .65rem;font:inherit;
       border:1px solid #ccd0d5;border-radius:6px;box-sizing:border-box}
 button{margin-top:1rem;padding:.55rem 1.1rem;font:inherit;font-weight:600;
        color:#fff;background:#1b74e4;border:0;border-radius:6px;
        cursor:pointer}
 p.note{font-size:.85rem;color:#65686c;margin:1rem 0 0}
</style>
<main>${body}</main>`;
}

function formPage(portalUrl: string, alias: string, action: string): string {
  const escape = (s: string) =>
    s.replace(
      /[&<>"]/g,
      (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
    );
  return page(
    `<h1>Connect a Zuar Portal</h1>
     <dl>
       <dt>Portal</dt><dd>${escape(portalUrl)}</dd>
       <dt>Alias</dt><dd>${escape(alias)}</dd>
     </dl>
     <form method="post" action="${escape(action)}">
       <label for="api_key">Admin API key</label>
       <input id="api_key" name="api_key" type="password" autofocus
              autocomplete="off" spellcheck="false">
       <button type="submit">Connect</button>
     </form>
     <p class="note">The key goes straight from this page to the client
     on your machine. It is never shown to the assistant.</p>`,
  );
}

/**
 * Collect an admin API key through a form served on loopback.
 *
 * The key travels from the browser to this process and nowhere else:
 * it is never a tool argument, so it cannot enter the model's context
 * or the session transcript.
 */
export function requestApiKey(options: {
  portalUrl: string;
  alias: string;
  timeoutMs?: number;
  onReady?: (url: string) => void;
}): Promise<string> {
  const { portalUrl, alias, onReady } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Unguessable path: another local process cannot post a key into
  // this flow, and a stray browser tab cannot reach it either.
  const token = crypto.randomBytes(24).toString("hex");
  const formPath = `/${token}`;

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      fn();
    };

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      // A browser resolving a hostname that points back here would
      // arrive with that hostname in Host; only loopback is ours.
      const host = (req.headers.host ?? "").split(":")[0];
      const isLoopback = host === "127.0.0.1" || host === "localhost";
      if (!isLoopback || url.pathname !== formPath) {
        res.writeHead(404).end();
        return;
      }
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(formPage(portalUrl, alias, formPath));
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = new URLSearchParams(Buffer.concat(chunks).toString());
        const apiKey = (body.get("api_key") ?? "").trim();
        if (!apiKey) {
          res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          res.end(page("<h1>No key entered</h1><p>Go back and try again.</p>"));
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          page(
            `<h1>Connected</h1><p><strong>${alias}</strong> is registered
             on this machine. You can close this tab.</p>`,
          ),
        );
        finish(() => resolve(apiKey));
      });
    });

    const timer = setTimeout(() => {
      finish(() =>
        reject(new ConnectFormError("no key was entered before the timeout")),
      );
    }, timeoutMs);
    timer.unref?.();

    server.on("error", (err) => finish(() => reject(err)));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "string" || address === null) {
        finish(() =>
          reject(new ConnectFormError("could not open a local port")),
        );
        return;
      }
      onReady?.(`http://127.0.0.1:${address.port}${formPath}`);
    });
  });
}

/**
 * Best-effort browser launch; failure is reported, never fatal.
 *
 * A missing opener surfaces as an asynchronous `error` event, not a
 * throw — unhandled, that event takes the process down, which is why
 * the answer is a promise rather than a boolean.
 */
export function openBrowser(url: string): Promise<boolean> {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args as string[], {
        stdio: "ignore",
        detached: true,
      });
    } catch {
      resolve(false);
      return;
    }
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}
