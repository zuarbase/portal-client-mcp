// Minimal JSON-RPC-over-stdio driver for the Client MCP under test.
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));

export class ClientMcp {
  constructor(env = {}, cwd = process.cwd()) {
    this.proc = spawn("node", [ENTRY], {
      env: { ...process.env, ...env },
      cwd,
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.pending = new Map();
    this.nextId = 0;
    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const resolve = this.pending.get(msg.id);
      if (resolve) {
        this.pending.delete(msg.id);
        resolve(msg);
      }
    });
  }

  request(method, params) {
    const id = ++this.nextId;
    const promise = new Promise((resolve) => this.pending.set(id, resolve));
    const msg = { jsonrpc: "2.0", id, method };
    if (params) msg.params = params;
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
    return promise;
  }

  notify(method) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  }

  async init() {
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test-driver", version: "0" },
    });
    this.notify("notifications/initialized");
  }

  async call(name, args = {}) {
    const r = await this.request("tools/call", { name, arguments: args });
    return {
      text: r.result.content[0].text,
      isError: r.result.isError ?? false,
    };
  }

  close() {
    this.proc.kill();
  }
}
