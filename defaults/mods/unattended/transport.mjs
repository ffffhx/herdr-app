import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";

const COMMANDS = {
  codex: ["codex", ["app-server", "--listen", "stdio://"]],
  claude: ["claude", ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-mode", "default", "--permission-prompt-tool", "stdio"]],
};

export function childEnvironment(environment = process.env, platform = process.platform) {
  const env = { ...environment };
  if (platform !== "win32") return env;
  // cmd ignores PATH when it exceeds 8191 characters. Windows agent sessions
  // can accumulate stale temporary shim directories; retain every live entry,
  // in the original order, while dropping duplicates and nonexistent entries.
  const key = Object.keys(env).find(k => k.toLowerCase() === "path");
  if (key) {
    const seen = new Set();
    env[key] = env[key].split(";").filter(p => {
      const normalized = p.toLowerCase();
      if (seen.has(normalized) || (p && !existsSync(p.replace(/^"|"$/g, "")))) return false;
      seen.add(normalized); return true;
    }).join(";");
  }
  return env;
}

export function commandFor(engine, resumeSessionId) {
  const [command, defaults] = COMMANDS[engine] ?? [];
  if (!command) throw new Error(`Unsupported agent: ${engine}`);
  const args = [...defaults];
  if (engine === "claude" && resumeSessionId !== undefined) {
    // UUIDs only: a Windows .cmd shim must never receive shell syntax.
    if (typeof resumeSessionId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(resumeSessionId)) throw new Error("Invalid Claude session ID");
    args.push("--resume", resumeSessionId);
  }
  return [command, args];
}

export function startProcess(engine, { cwd, resumeSessionId, onMessage, onError, onExit, stderr, launch } = {}) {
  const [command, args] = commandFor(engine, resumeSessionId);
  // Windows npm installs expose .cmd shims. Only these constant, built-in
  // commands and validated UUIDs go through cmd; task text travels on stdin.
  const child = launch ? launch() : process.platform === "win32"
    ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `${command} ${args.join(" ")}`], { cwd, env: childEnvironment(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
    : spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let ended = false;
  child.on("error", onError);
  child.on("close", (code, signal) => { ended = true; onExit?.(code, signal); });
  child.stdin.on("error", error => { if (!ended) onError?.(error); });
  child.stderr.on("data", data => stderr?.(data.toString()));
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", line => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch { onError?.(new Error(`Invalid ${engine} protocol output: ${line.slice(0,160)}`)); return; }
    Promise.resolve(onMessage(message)).catch(onError);
  });
  return {
    child,
    send(message) {
      if (ended || child.stdin.destroyed) throw new Error(`${engine} connection is closed`);
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    close() { child.stdin.end(); },
  };
}

export class Requests {
  constructor(send) { this.send = send; this.next = 1; this.pending = new Map(); }
  call(method, params) {
    const id = `herdr-${this.next++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out; outcome unknown`)); }, 60000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  receive(message) {
    const pending = this.pending.get(message.id);
    if (!pending || message.method) return false;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
    return true;
  }
  close() {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Agent connection closed")); }
    this.pending.clear();
  }
}
