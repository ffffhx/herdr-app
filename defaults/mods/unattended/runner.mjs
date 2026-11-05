// This process belongs to the hc terminal, so it survives closing the Herdr window.
// Node built-ins only: no SDK installation, API key copy, daemon, or listening port.
import { readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { Codex, Claude } from "./adapters.mjs";
import { Supervisor } from "./supervisor.mjs";
import { instructions } from "./policy.mjs";
import { startProcess } from "./transport.mjs";

const help = `Herdr unattended agent
  node runner.mjs --config <task.json> [--once]

task.json: {"agent":"codex"|"claude", "task":"...", "cwd":"absolute directory",
            "enabled":true, "exceptions":["literal request keyword"]}

During a session, type a message or:
  /auto on|off             change automatic approval immediately
  /except <keyword>        add an exception (case-insensitive literal match)
  /exceptions              list exceptions
  /allow <request-id>      approve a pending request once
  /deny <request-id>       decline a pending request
  /answer <id> <answer>    answer a question (JSON object for multiple questions)
  /status                 show state and pending request IDs
  /interrupt              interrupt the current turn, keep the session
  /quit                   end this session

Commands are handled by Herdr; other input goes to the selected agent.
Existing agents and their global settings are not modified.
`;

function clean(text) {
  return String(text).replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}
function atomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}
function validatePolicy(value) {
  if (typeof value.enabled !== "boolean" || !Array.isArray(value.exceptions) || value.exceptions.some(x => typeof x !== "string")) throw new Error("Policy needs enabled:boolean and exceptions:string[]");
  return { enabled: value.enabled, exceptions: value.exceptions.map(x => x.trim()).filter(Boolean) };
}

export async function run(configPath, { once = false, input = process.stdin, output = process.stdout, transportFactory = startProcess } = {}) {
  const path = resolve(configPath);
  const config = JSON.parse(readFileSync(path, "utf8"));
  if (!["codex", "claude"].includes(config.agent)) throw new Error("agent must be codex or claude");
  if (typeof config.task !== "string" || !config.task.trim()) throw new Error("A task is required");
  const cwd = resolve(config.cwd ?? process.cwd());
  if (!statSync(cwd).isDirectory()) throw new Error("cwd must be a directory");
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const controlPath = join(directory, "control.json"), statePath = join(directory, "state.json"), logPath = join(directory, "events.jsonl");
  const initial = validatePolicy({ enabled: config.enabled ?? true, exceptions: config.exceptions ?? [] });
  // A second launch against the same run directory would share policy and logs.
  // The launcher creates a new directory for every run; never resume implicitly.
  const lockPath = join(directory, "started.json");
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started: Date.now() }), { flag: "wx", mode: 0o600 });
  atomic(controlPath, initial);
  let sessionId = null, ended = false, ready = false, closing = false, transport, adapter, stateError = null;
  let approvalCount = 0, lastStatus = null, policyText = JSON.stringify(initial), exitCode = 0;
  const events = [];
  const out = text => output.write(clean(text));
  const audit = event => {
    const record = { time: new Date().toISOString(), ...event };
    // Never retain a manually entered secret answer in the approval journal.
    if (record.type === "decision" && record.source === "user") record.response = "[manual response]";
    appendFileSync(logPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    if (event.type === "decision" && event.source === "automatic") approvalCount++;
    events.push({ time: record.time, type: record.type, kind: record.kind, source: record.source, reason: record.reason });
    if (events.length > 40) events.shift();
  };
  const saveState = status => {
    atomic(statePath, { agent: config.agent, pid: process.pid, running: !ended, terminal: process.env.HC_TERMINAL_ID ?? null, sessionId, status, enabled: supervisor.enabled, exceptions: supervisor.exceptions, approvalCount, pending: [...supervisor.pending.values()].map(r => ({ id: String(r.id), kind: r.kind })), events, updated: Date.now(), error: stateError });
    if (lastStatus !== status) {
      lastStatus = status;
      output.write(`\x1b]7501;state=${status}:app=${config.agent === "claude" ? "claude-code" : "codex"}\x1b\\`);
    }
  };
  const refresh = () => {
    try {
      const next = validatePolicy(JSON.parse(readFileSync(controlPath, "utf8")));
      const serialized = JSON.stringify(next);
      stateError = null;
      if (serialized !== policyText) { policyText = serialized; supervisor.configure(next.enabled, next.exceptions); }
    } catch (error) {
      policyText = null;
      // A malformed or missing policy is visible and never silently enables Yes.
      supervisor.configure(false, supervisor.exceptions);
      stateError = `Cannot read approval policy: ${error.message}`;
      if (supervisor.status !== "error") { out(`\n[Herdr] ${stateError}\n`); supervisor.setState("error"); }
    }
  };
  const supervisor = new Supervisor({ ...initial, audit, output: out, state: saveState, refresh });
  const fail = error => {
    stateError = error.message;
    out(`\n[Herdr] ${stateError}\n`);
    exitCode = 1;
    try { supervisor.configure(false, supervisor.exceptions); supervisor.setState("error"); } catch { /* Disk failure is already reported to the terminal. */ }
  };
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const host = {
    send: message => transport.send(message), output: out,
    notice: text => out(`\n${text}\n`), state: status => supervisor.setState(status),
    session: id => { sessionId = id; audit({ type: "session", agent: config.agent, sessionId }); saveState(supervisor.status); },
    request: request => supervisor.request(request), resolved: id => supervisor.resolved(id),
    clearRequests: () => supervisor.clearRequests(),
    finished: async result => {
      await supervisor.finished(result);
      if (once && ["done", "error", "idle"].includes(supervisor.status)) {
        if (supervisor.status === "error") exitCode = 1;
        await shutdown();
      }
    },
  };
  adapter = config.agent === "codex" ? new Codex(host) : new Claude(host);
  supervisor.adapter = adapter;
  const lines = createInterface({ input, crlfDelay: Infinity });
  const waitingInput = [];
  let inputChain = Promise.resolve();
  async function shutdown() {
    if (closing) return;
    closing = true;
    supervisor.configure(false, supervisor.exceptions);
    try { if (supervisor.status === "working" || supervisor.pending.size) await adapter.interrupt(); } catch (error) { out(`\n[Herdr] ${error.message}\n`); }
    transport.close();
    lines.close();
  }
  function setPolicy(enabled, exceptions) {
    atomic(controlPath, validatePolicy({ enabled, exceptions }));
    refresh(); supervisor.retryPending();
  }
  async function handle(line) {
    const text = line.trim();
    if (!text) return;
    if (text === "/help") { out(help); return; }
    if (text === "/auto off" || text === "/auto on") { setPolicy(text.endsWith("on"), supervisor.exceptions); out(`\n[Herdr] Automatic approval ${supervisor.enabled ? "ON" : "OFF"}\n`); return; }
    if (text.startsWith("/except ")) { setPolicy(supervisor.enabled, [...supervisor.exceptions, text.slice(8).trim()]); return; }
    if (text === "/exceptions") { out(`${JSON.stringify(supervisor.exceptions)}\n`); return; }
    if (text === "/status") { out(`${JSON.stringify({ status: supervisor.status, enabled: supervisor.enabled, pending: [...supervisor.pending.keys()], sessionId, logPath }, null, 2)}\n`); return; }
    const manual = /^\/(allow|deny|answer)\s+(\S+)(?:\s+([\s\S]*))?$/.exec(text);
    if (manual) { supervisor.manual(manual[2], manual[1], manual[3] ?? ""); return; }
    if (text === "/quit") { await shutdown(); return; }
    if (text === "/interrupt") { setPolicy(false, supervisor.exceptions); await adapter.interrupt(); return; }
    if (text.startsWith("/")) { out("Unknown Herdr command. Use /help.\n"); return; }
    supervisor.repeated.clear();
    await adapter.submit(line);
  }
  lines.on("line", line => {
    if (!ready) { waitingInput.push(line); return; }
    // A policy stop must not sit behind an in-flight turn/start RPC.
    if (line.trim() === "/auto off") { try { setPolicy(false, supervisor.exceptions); out("\n[Herdr] Automatic approval OFF\n"); } catch (error) { fail(error); } return; }
    inputChain = inputChain.then(() => handle(line)).catch(error => out(`\n[Herdr] ${error.message}\n`));
  });
  lines.on("SIGINT", () => { if (ready) { setPolicy(false, supervisor.exceptions); adapter.interrupt().catch(fail); } });
  transport = transportFactory(config.agent, {
    cwd, onMessage: message => adapter.receive(message), onError: fail,
    stderr: text => out(text),
    onExit: (code, signal) => {
      ended = true; adapter.close(); lines.close();
      if (!closing || code || signal) { exitCode = code || 1; fail(new Error(`${config.agent} exited (${signal ?? code}); session was not restarted`)); }
      try { audit({ type: "exit", code, signal }); saveState(supervisor.status); } catch { /* The terminal already holds the error. */ }
      resolveClosed(exitCode);
    },
  });
  const timer = setInterval(() => {
    if (ended || closing) return;
    try { refresh(); supervisor.retryPending(); saveState(supervisor.status); } catch (error) { fail(error); }
  }, 2000);
  try {
    out(`[Herdr] ${config.agent} unattended session. Automatic approval ${initial.enabled ? "ON" : "OFF"}.\nCommands: /auto off, /except <keyword>, /status, /help, /quit\nAudit: ${logPath}\n`);
    supervisor.setState("working");
    await adapter.initialize(cwd);
    ready = true;
    // Apply control commands typed during startup before starting any work.
    // Ordinary steering follows the initial task, in the order it was typed.
    for (const line of waitingInput.filter(line => line.trim().startsWith("/"))) await handle(line);
    if (!closing) await adapter.submit(supervisor.enabled ? `${instructions(supervisor.exceptions)}\n\nTask:\n${config.task}` : config.task);
    for (const line of waitingInput.filter(line => !line.trim().startsWith("/"))) if (!closing) await handle(line);
  } catch (error) { fail(error); await shutdown(); }
  const result = await closed;
  clearInterval(timer);
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || !args.length) { console.log(help); }
  else {
    const index = args.indexOf("--config");
    if (index < 0 || !args[index + 1]) { console.error("Use --config <task.json>"); process.exitCode = 2; }
    else run(args[index + 1], { once: args.includes("--once") }).then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
