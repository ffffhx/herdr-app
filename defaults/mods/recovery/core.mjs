import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// All state and input go through the installed core's public API. No private
// database edits, raw PTY access, or shell interpolation of JSON arguments.
export class Core {
  constructor(binary = process.env.HERDR_RECOVERY_CORE || (process.platform === "win32" ? "hc.exe" : "hc")) {
    this.next = 0;
    this.pending = new Map();
    this.child = spawn(binary, ["connect"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child.stderr.on("data", () => {});
    this.child.on("error", error => this.fail(error));
    this.child.on("exit", () => this.fail(new Error("The terminal service disconnected")));
    this.child.stdin.on("error", error => this.fail(error));
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", line => {
      let value;
      try { value = JSON.parse(line); } catch { return; }
      const pending = this.pending.get(value.id);
      if (!pending) return;
      this.pending.delete(value.id);
      clearTimeout(pending.timer);
      if (value.error) pending.reject(Object.assign(new Error(value.error.message), { kind: value.error.data?.kind }));
      else pending.resolve(value.result);
    });
  }
  call(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("The terminal service disconnected"));
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`${method}: no reply; reconcile before retrying`), { unknown: true }));
      }, 12000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  async update(name, change) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const doc = await this.call("doc.get", { name });
      const value = change(doc.value);
      if (value === undefined) return doc.value;
      try { await this.call("doc.set", { name, version: doc.version, value }); return value; }
      catch (error) { if (error.kind !== "conflict") throw error; }
    }
    throw new Error("Session state changed repeatedly; try again");
  }
  fail(error) {
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }
  close() { this.fail(new Error("Connection closed")); this.lines.close(); this.child.stdin.end(); this.child.kill(); }
}
