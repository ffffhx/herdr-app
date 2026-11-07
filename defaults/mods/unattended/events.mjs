import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// CLI snapshots and JSON-RPC notifications share this stream. Labels, titles
// and output are deliberately ignored: our own badge must not trigger a loop.
export function eventFilter(terminal) {
  let seq = -1;
  const facts = new Map();
  return message => {
    const snapshot = message.method === "missed" ? message.params : message;
    if (Array.isArray(snapshot?.terminals)) {
      seq = snapshot.seq ?? -1; facts.clear(); return true;
    }
    const p = message.method === "event" ? message.params : null;
    if (!p || p.terminal !== terminal || (typeof p.seq === "number" && p.seq <= seq)) return false;
    if (typeof p.seq === "number") seq = p.seq;
    if (!["status", "turn", "created", "restarted", "finished", "lost", "removed"].includes(p.type)) return false;
    const value = JSON.stringify(p.type === "status" ? [p.data?.reported, p.data?.status] : p.data);
    if (facts.has(p.type) && facts.get(p.type) === value) return false;
    facts.set(p.type, value);
    return true;
  };
}

// One persistent read-only hc client instead of spawning a process every tick.
// Reconnect on failure with bounded backoff; the observer's fallback remains on.
export function subscribeTerminal(terminal, { change, connection = () => {}, launch = spawn, retryMs = 1000, maxRetryMs = 30000 } = {}) {
  let stopped = false, child, lines, timer, delay = retryMs;
  const start = () => {
    if (stopped) return;
    const accepts = eventFilter(terminal);
    let connected = false;
    const lost = () => { if (connected) { connected = false; connection(false); } };
    try {
      child = launch(process.platform === "win32" ? "hc.exe" : "hc", ["events", "--json", "--terminal", terminal], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch { reconnect(); return; }
    lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    child.stderr.resume();
    lines.on("line", line => {
      if (stopped || !line.trim()) return;
      try {
        const message = JSON.parse(line);
        if (accepts(message)) {
          if (!connected) { connected = true; delay = retryMs; connection(true); }
          change();
        }
      } catch { lost(); child.kill(); }
    });
    child.on("error", lost);
    child.on("close", () => { lines.close(); lost(); reconnect(); });
  };
  const reconnect = () => {
    if (stopped) return;
    timer = setTimeout(start, delay);
    delay = Math.min(maxRetryMs, delay * 2);
  };
  start();
  return () => { stopped = true; clearTimeout(timer); lines?.close(); child?.kill(); };
}

// Coalesce bursts while a check is in flight. Keep a wakeup that arrived before
// waiting, and cancel the wait immediately when the owning terminal exits.
export class Wakeups {
  pending = new Set();
  wake(reason) { this.pending.add(reason); this.resume?.(); }
  async wait(timeout, signal) {
    if (!this.pending.size && !signal?.aborted) await new Promise(resolve => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); this.resume = null; resolve(); };
      const timer = setTimeout(done, Math.max(0, timeout));
      this.resume = done;
      signal?.addEventListener("abort", done, { once: true });
    });
    const reasons = this.pending; this.pending = new Set(); return reasons;
  }
}
