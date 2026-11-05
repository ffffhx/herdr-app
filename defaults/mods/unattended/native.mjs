// Automatic confirmation beside a native TUI. Never replace its renderer,
// interrupt its turn, clear its composer, or submit a replacement task.
import { readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { hc, lockSession } from "./sessions.mjs";
import { childEnvironment } from "./transport.mjs";
import { exceptionFor, needsHandBack } from "./policy.mjs";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const agentApp = (agent, app) => agent === "codex" ? app === "codex" : ["claude", "claude-code"].includes(app);

export function sameTerminal(term, source, agent) {
  return term.address === source.address && term.created_ms === source.created_ms && term.pid === source.pid
    && term.state === "live" && term.reported && agentApp(agent, term.status?.app);
}

// Recognize the native confirmation card at the bottom of the *live screen*.
// A Yes in model text, history, a settings menu, or a composer is not a request.
// These single-key shortcuts accept once; never select "always allow".
export function nativeConfirmation(agent, term, screen) {
  if (term.status?.state !== "blocked" || term.status.kind !== "permission") return null;
  const text = String(screen).replace(/\r/g, "").trimEnd();
  let card, keys;
  if (agent === "codex") {
    if (!/\n\s*Press enter to confirm or esc to cancel\s*$/i.test(text)) return null;
    const start = text.lastIndexOf("Would you like to ");
    if (start < 0) return null;
    card = text.slice(start);
    if (!/^\s*[›>] ?\d+\. Yes, proceed \(y\)\s*$/m.test(card)
      || !/^\s*\d+\. No, and tell Codex what to do differently \(esc\)\s*$/m.test(card)) return null;
    keys = ["y"];
  } else if (agent === "claude") {
    if (!/\n\s*Esc to cancel(?:\s*·[^\n]*)?\s*$/i.test(text)) return null;
    const start = text.lastIndexOf("Do you want to ");
    if (start < 0) return null;
    // Include the command/diff above the choices when matching exceptions.
    card = text.slice(Math.max(0, text.lastIndexOf("\n\n", start - 1)));
    const choices = text.slice(start);
    if (!/^\s*[>❯] 1\. Yes\s*$/m.test(choices) || !/^\s*\d+\. No\s*$/m.test(choices)) return null;
    keys = ["1"];
  } else return null;
  if (needsHandBack(card) || /(?:enter|provide|type|输入|提供|填写).{0,60}(?:password|verification code|api key|密码|验证码|密钥)/i.test(card)) return null;
  return { keys, text: card, kind: "native/permission", context: `${term.status.msg ?? ""}\n${card}` };
}

export class NativeApprovals {
  constructor({ agent, source, call = hc, policy, audit = () => {}, settle = () => delay(150) }) {
    Object.assign(this, { agent, source, call, policy, audit, settle });
    this.answered = new Set();
    this.approvalCount = 0;
  }
  async tick() {
    const before = await this.call(["get", this.source.address]);
    if (!sameTerminal(before, this.source, this.agent)) return { ended: true, term: before };
    const policy = this.policy();
    if (!policy.enabled || before.status?.state !== "blocked") return { term: before };
    const screen = (await this.call(["read", this.source.address, "--lines", "0"])).text;
    const request = nativeConfirmation(this.agent, before, screen);
    if (!request || exceptionFor(request.context, policy.exceptions)) return { term: before };
    const id = JSON.stringify([before.turn, before.status_ms, request.context]);
    if (this.answered.has(id)) return { term: before };
    await this.settle();
    // Re-read both identity and card immediately before the one-key decision.
    // Manual selection changes, user answers and disabled policy take priority.
    const frame = (await this.call(["read", this.source.address, "--lines", "0"])).text;
    const current = await this.call(["get", this.source.address]);
    const currentPolicy = this.policy();
    if (!sameTerminal(current, this.source, this.agent) || current.turn !== before.turn
      || current.status_ms !== before.status_ms || frame !== screen || !currentPolicy.enabled
      || !nativeConfirmation(this.agent, current, frame)
      || exceptionFor(request.context, currentPolicy.exceptions)) return { term: current };
    // Record before delivery. An uncertain delivery must never be replayed.
    this.audit({ type: "decision", source: "automatic", kind: request.kind, terminal: this.source.address, request: request.context, keys: request.keys });
    this.answered.add(id);
    await this.call(["keys", this.source.address, ...request.keys]);
    this.approvalCount++;
    return { term: current, approved: true };
  }
}

function atomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export async function watch(configPath, { call = hc, signal, waitForAgent = false } = {}) {
  const path = resolve(configPath), directory = dirname(path);
  const config = JSON.parse(readFileSync(path, "utf8"));
  if (!["codex", "claude"].includes(config.agent)) throw new Error("Unknown native agent");
  const terminal = config.source?.address ?? process.env.HC_TERMINAL_ID;
  if (!/^t[0-9a-z]+$/.test(terminal ?? "")) throw new Error("A native hc terminal is required");
  const source = config.source ?? await call(["get", terminal]);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "started.json"), JSON.stringify({ pid: process.pid, started: Date.now() }), { flag: "wx", mode: 0o600 });
  const controlPath = join(directory, "control.json"), statePath = join(directory, "state.json");
  atomic(controlPath, { enabled: config.enabled ?? true, exceptions: config.exceptions ?? [] });
  let ready = false, running = true, error = null, label = null, ownsSource = false, release = () => {};
  const audit = event => appendFileSync(join(directory, "events.jsonl"), `${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
  const policy = () => {
    const value = JSON.parse(readFileSync(controlPath, "utf8"));
    if (typeof value.enabled !== "boolean" || !Array.isArray(value.exceptions) || value.exceptions.some(s => typeof s !== "string")) throw new Error("Invalid automatic approval policy");
    return value;
  };
  const observer = new NativeApprovals({ agent: config.agent, source, call, policy, audit });
  const save = async term => {
    const p = error ? { enabled: false, exceptions: [] } : policy();
    atomic(statePath, { agent: config.agent, native: true, pid: process.pid, running, ready, terminal, sourceTerminal: terminal, sourceCreated: source.created_ms,
      status: error ? "error" : term?.status?.state ?? "idle", enabled: p.enabled, exceptions: p.exceptions, approvalCount: observer.approvalCount, pending: [], updated: Date.now(), error });
    const next = running && ready && p.enabled && !error ? "on" : "off";
    if (ownsSource && label !== next) {
      label = next;
      await call(["label", terminal, `herdr.unattended=${next}`, `herdr.unattended.control=${controlPath}`]);
    }
  };
  try {
    release = lockSession("native", `${terminal}-${source.created_ms}`, join(dirname(directory), "session-locks"));
    ownsSource = true;
    let term = await call(["get", terminal]);
    // A newly created native TUI may still be booting or showing its trust UI.
    // The watcher does not answer setup/trust screens or change the composer.
    const deadline = Date.now() + 120000;
    while (!sameTerminal(term, source, config.agent) && waitForAgent && !signal?.aborted
      && term.state === "live" && term.pid === source.pid && Date.now() < deadline) {
      await save(term); await delay(500); term = await call(["get", terminal]);
    }
    if (!sameTerminal(term, source, config.agent)) throw new Error("The selected agent is no longer running");
    ready = true;
    audit({ type: "attached", agent: config.agent, terminal, created_ms: source.created_ms });
    await save(term);
    while (!signal?.aborted) {
      const result = await observer.tick();
      if (result.ended) break;
      await save(result.term);
      await delay(500);
    }
  } catch (reason) { error = reason.message; audit({ type: "error", error }); }
  finally {
    running = false;
    try { await save(); } finally { release(); }
  }
  return error ? 1 : 0;
}

// New tasks also use the real agent UI, with an approval observer alongside it.
// Task text stays data. On Windows PowerShell reads it from JSON, so quotes,
// newlines and shell syntax in the task never become part of a command string.
export async function native(configPath) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (!["codex", "claude"].includes(config.agent)) throw new Error("Unknown native agent");
  const args = config.task?.trim() ? [config.task] : [];
  const keepParent = () => {}; // The native TUI handles the console's Ctrl+C.
  process.on("SIGINT", keepParent);
  const child = process.platform === "win32"
    ? spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", `$nativeTask = Get-Content -LiteralPath $env:HERDR_UNATTENDED_TASK_FILE -Raw -Encoding UTF8 | ConvertFrom-Json; if ($nativeTask.task) { & ${config.agent} $nativeTask.task } else { & ${config.agent} }; exit $LASTEXITCODE`],
      { cwd: config.cwd, env: { ...childEnvironment(), HERDR_UNATTENDED_TASK_FILE: resolve(configPath) }, windowsHide: true, stdio: "inherit" })
    : spawn(config.agent, args, { cwd: config.cwd, stdio: "inherit" });
  const controller = new AbortController();
  const closed = new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", code => { controller.abort(); resolve(code ?? 1); }); });
  const monitoring = watch(configPath, { waitForAgent: true, signal: controller.signal });
  try { return await closed; }
  finally { controller.abort(); await monitoring; process.off("SIGINT", keepParent); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const path = process.argv[process.argv.indexOf("--config") + 1];
  (process.argv.includes("--watch") ? watch(path) : native(path))
    .then(code => { process.exitCode = code; }).catch(error => { console.error(`[Herdr] ${error.message}`); process.exitCode = 1; });
}
