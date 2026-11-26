// Automatic confirmation beside a native TUI. Never replace its renderer,
// interrupt its turn, clear its composer, or submit a replacement task.
import { createReadStream, statSync, readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync, watchFile, unwatchFile, watch as watchDirectory } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, resolve, join, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { hc, lockSession } from "./sessions.mjs";
import { childEnvironment } from "./transport.mjs";
import { exceptionFor, needsHandBack } from "./policy.mjs";
import { subscribeTerminal, Wakeups } from "./events.mjs";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const agentApp = (agent, app) => agent === "codex" ? app === "codex" : ["claude", "claude-code"].includes(app);

export function sameTerminal(term, source, agent) {
  return term.address === source.address && term.created_ms === source.created_ms && term.pid === source.pid
    && term.state === "live" && (agent === "antigravity"
      ? /^(agy|antigravity)(\.exe)?$/i.test(term.status?.app || term.foreground?.name)
      : term.reported && agentApp(agent, term.status?.app));
}

// Recognize the native confirmation card at the bottom of the *live screen*.
// A Yes in model text, history, a settings menu, or a composer is not a request.
// These single-key shortcuts accept once; never select "always allow".
export function nativeConfirmation(agent, term, screen) {
  if (term.status?.state !== "blocked" || term.status.kind !== "permission") return null;
  const text = String(screen).replace(/\r/g, "").trimEnd();
  let card, keys;
  if (agent === "codex") {
    // Child-agent cards add a navigation shortcut in the parent TUI. Keep the
    // footer anchored so drafts and unrecognized prompts are still ignored.
    if (!/\n\s*Press enter to confirm or esc to cancel(?:\s+or o to open thread)?\s*$/i.test(text)) return null;
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
    if (this.agent === "antigravity" || !policy.enabled || before.status?.state !== "blocked" || before.status.kind !== "permission") return { term: before };
    const screen = (await this.call(["read", this.source.address, "--lines", "0"])).text;
    const request = nativeConfirmation(this.agent, before, screen);
    if (!request) return { term: before, retry: true };
    if (exceptionFor(request.context, policy.exceptions)) return { term: before };
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
      || exceptionFor(request.context, currentPolicy.exceptions)) return { term: current, retry: true };
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

export async function watch(configPath, { call = hc, signal, waitForAgent = false, subscribe = subscribeTerminal, fallbackMs = 10000, heartbeatMs = 5000 } = {}) {
  const path = resolve(configPath), directory = dirname(path);
  const config = JSON.parse(readFileSync(path, "utf8"));
  if (!["codex", "claude", "antigravity"].includes(config.agent)) throw new Error("Unknown native agent");
  const terminal = config.source?.address ?? process.env.HC_TERMINAL_ID;
  if (!/^t[0-9a-z]+$/.test(terminal ?? "")) throw new Error("A native hc terminal is required");
  const source = config.source ?? await call(["get", terminal]);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "started.json"), JSON.stringify({ pid: process.pid, started: Date.now() }), { flag: "wx", mode: 0o600 });
  const controlPath = join(directory, "control.json"), statePath = join(directory, "state.json");
  atomic(controlPath, { enabled: config.enabled ?? true, exceptions: config.exceptions ?? [] });
  let ready = false, running = true, error = null, label = null, ownsSource = false, release = () => {};
  let stopEvents = () => {}, controlWatch, connected = false, lastWrite = 0, lastState = "";
  const wakeups = new Wakeups();
  const audit = event => appendFileSync(join(directory, "events.jsonl"), `${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
  const policy = () => {
    const value = JSON.parse(readFileSync(controlPath, "utf8"));
    if (typeof value.enabled !== "boolean" || !Array.isArray(value.exceptions) || value.exceptions.some(s => typeof s !== "string")) throw new Error("Invalid automatic approval policy");
    return value;
  };
  let agentPid;
  const observer = new NativeApprovals({ agent: config.agent, source, call, policy, audit });
  let journalOffset = 0;
  const journal = join(directory, "events.jsonl");
  const save = async term => {
    // Hook decisions are written by the CLI process. Count newly appended
    // records on heartbeat without re-reading the history of a long session.
    if (config.agent === "antigravity") {
      const end = statSync(journal, { throwIfNoEntry: false })?.size || 0;
      if (end > journalOffset) {
        const lines = createInterface({ input: createReadStream(journal, { start: journalOffset, end: end - 1 }) });
        for await (const line of lines) if (JSON.parse(line).type === "decision") observer.approvalCount++;
        journalOffset = end;
      }
    }
    const p = error ? { enabled: false, exceptions: [] } : policy();
    const state = { agent: config.agent, native: true, pid: process.pid, running, ready, terminal, sourceTerminal: terminal, sourceCreated: source.created_ms, sourcePid: source.pid, agentPid,
      status: error ? "error" : term?.status?.state ?? "idle", enabled: p.enabled, exceptions: p.exceptions, approvalCount: observer.approvalCount, pending: [], monitoring: connected ? "events" : "fallback", error };
    const serialized = JSON.stringify(state), now = Date.now();
    if (serialized !== lastState || now - lastWrite >= heartbeatMs) {
      atomic(statePath, { ...state, updated: now }); lastWrite = now; lastState = serialized;
    }
    const next = running && ready && p.enabled && !error ? "on" : "off";
    if (ownsSource && label !== next) {
      label = next;
      await call(["label", terminal, `herdr.unattended=${next}`, `herdr.unattended.control=${controlPath}`]);
    }
  };
  try {
    release = lockSession("native", `${terminal}-${source.created_ms}`, join(dirname(directory), "session-locks"), { reclaimDeadObserver: config.recovered === true });
    ownsSource = true;
    stopEvents = subscribe(terminal, { change: () => wakeups.wake("event"), connection: value => { connected = value; wakeups.wake("connection"); } });
    // Watch the directory so atomic replacement of control.json stays visible.
    // Some macOS environments reject directory watches asynchronously. Watch
    // the policy file by stat in that case, including across atomic renames.
    const onPolicy = () => wakeups.wake("policy");
    const pollPolicy = () => {
      controlWatch?.close();
      watchFile(controlPath, { interval: 500, persistent: false }, onPolicy);
      controlWatch = { close: () => unwatchFile(controlPath, onPolicy) };
    };
    try {
      controlWatch = watchDirectory(directory, (_event, file) => { if (!file || basename(String(file)) === "control.json") wakeups.wake("policy"); });
      controlWatch.on("error", pollPolicy);
    } catch { pollPolicy(); }
    let term = await call(["get", terminal]);
    // A newly created native TUI may still be booting or showing its trust UI.
    // The watcher does not answer setup/trust screens or change the composer.
    const deadline = Date.now() + 120000;
    while (!sameTerminal(term, source, config.agent) && waitForAgent && !signal?.aborted
      && term.state === "live" && term.pid === source.pid && Date.now() < deadline) {
      await save(term); await wakeups.wait(Math.min(heartbeatMs, deadline - Date.now()), signal);
      if (!signal?.aborted) term = await call(["get", terminal]);
    }
    if (!sameTerminal(term, source, config.agent)) throw new Error("The selected agent is no longer running");
    if (config.agent === "antigravity" && /^(agy|antigravity)(\.exe)?$/i.test(term.foreground?.name)) agentPid = term.foreground.pid;
    ready = true;
    audit({ type: "attached", agent: config.agent, terminal, created_ms: source.created_ms });
    await save(term);
    let nextCheck = 0, nextRetry = Infinity, retries = 0;
    while (!signal?.aborted) {
      const reasons = await wakeups.wait(Math.min(nextCheck, nextRetry, lastWrite + heartbeatMs) - Date.now(), signal);
      if (signal?.aborted) break;
      const now = Date.now(), changed = reasons.has("event") || reasons.has("policy");
      if (changed || now >= nextCheck || now >= nextRetry) {
        if (changed || now >= nextCheck) retries = 0;
        const result = await observer.tick();
        term = result.term;
        if (result.ended || (agentPid && term.foreground?.pid && agentPid !== term.foreground.pid)) break;
        // A status event can precede painting the permission card. Allow two
        // short settling retries, then return to the low-frequency fallback.
        nextRetry = result.retry && retries < 2 ? Date.now() + [250, 750][retries++] : Infinity;
        nextCheck = Date.now() + fallbackMs;
      }
      await save(term);
    }
  } catch (reason) { error = reason.message; audit({ type: "error", error }); }
  finally {
    stopEvents(); controlWatch?.close();
    running = false;
    try { await save(); } finally { release(); }
  }
  return error ? 1 : 0;
}

export function codexLaunchArgs(rawArgs, enabled = true) {
  if (enabled === false) return [...rawArgs];
  let preset = false, hasApproval = false, hasSandbox = false;
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (["--dangerously-bypass-approvals-and-sandbox", "--yolo", "--full-auto", "--approve-for-me", "-p", "--profile"].includes(arg)
      || arg.startsWith("--profile=")) preset = true;
    if (arg === "-a" || arg === "--ask-for-approval" || arg.startsWith("--ask-for-approval=")) hasApproval = true;
    if (arg === "-s" || arg === "--sandbox" || arg.startsWith("--sandbox=")) hasSandbox = true;
    const cfg = (arg === "-c" || arg === "--config") ? rawArgs[i + 1] : arg.startsWith("--config=") ? arg.slice(9) : null;
    if (typeof cfg === "string") {
      if (/^approval_policy\s*=/.test(cfg)) hasApproval = true;
      if (/^sandbox_mode\s*=/.test(cfg)) hasSandbox = true;
    }
  }
  if (preset) return [...rawArgs];
  const extra = [...(hasSandbox ? [] : ["-s", "workspace-write"]), ...(hasApproval ? [] : ["-a", "on-request"])];
  if (!extra.length) return [...rawArgs];
  const sub = rawArgs.findIndex(a => a === "resume" || a === "fork");
  return sub >= 0 ? [...rawArgs.slice(0, sub), ...extra, ...rawArgs.slice(sub)] : [...rawArgs, ...extra];
}

// New tasks also use the real agent UI, with an approval observer alongside it.
// Task text stays data. On Windows PowerShell reads it from JSON, so quotes,
// newlines and shell syntax in the task never become part of a command string.
export async function native(configPath, { launch = spawn, observe = watch, platform = process.platform, env = process.env, prepareAgyProfile, labelProfile } = {}) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (!["codex", "claude", "antigravity"].includes(config.agent)) throw new Error("Unknown native agent");
  const argv = config.argv ?? [config.agent === "antigravity" ? "agy" : config.agent];
  if (!Array.isArray(argv) || !argv.length || argv.some(a => typeof a !== "string") || !argv[0]) throw new Error("Invalid native agent command");
  const agyAuto = config.agent === "antigravity" && config.enabled !== false && !argv.includes("--dangerously-skip-permissions");
  const baseArgs = config.agent === "codex" ? codexLaunchArgs(argv.slice(1), config.enabled) : argv.slice(1);
  const args = [...baseArgs, ...(agyAuto ? ["--dangerously-skip-permissions"] : []), ...(config.task?.trim() ? (config.agent === "antigravity" ? ["--prompt-interactive", config.task] : [config.task]) : [])];
  let spawnEnv = null;
  if (config.agent === "antigravity" && config.profile?.id) {
    // Load dynamically so remote SSH unattended staging stays self-contained.
    const profiles = (!prepareAgyProfile || !labelProfile) ? await import("../antigravity-profiles/profiles.mjs") : null;
    const appHome = profiles ? profiles.defaultAppHome(env) : (env.HERDR_APP_HOME || "");
    const prepared = (prepareAgyProfile ?? profiles.prepareProfile)({ appHome, id: config.profile.id, name: config.profile.name, baseEnv: env, platform });
    (labelProfile ?? profiles.labelTerminalProfile)(prepared.id, prepared.name, { env: prepared.env, platform });
    spawnEnv = prepared.env;
  }
  const keepParent = () => {}; // The native TUI handles the console's Ctrl+C.
  process.on("SIGINT", keepParent);
  const child = platform === "win32"
    ? launch("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", "$nativeTask = Get-Content -LiteralPath $env:HERDR_UNATTENDED_TASK_FILE -Raw -Encoding UTF8 | ConvertFrom-Json; $nativeArgv = @($nativeTask.agent); if ($nativeTask.agent -eq 'antigravity') { $nativeArgv = @('agy') }; if ($nativeTask.argv) { $nativeArgv = @($nativeTask.argv) }; $nativeArgs = @($nativeArgv | Select-Object -Skip 1); if ($nativeTask.agent -eq 'codex' -and $nativeTask.enabled -ne $false) { $codexPreset = $false; $codexHasA = $false; $codexHasS = $false; for ($i = 0; $i -lt $nativeArgs.Count; $i++) { $ca = $nativeArgs[$i]; if ($ca -in @('--dangerously-bypass-approvals-and-sandbox','--yolo','--full-auto','--approve-for-me','-p','--profile') -or $ca.StartsWith('--profile=')) { $codexPreset = $true }; if ($ca -in @('-a','--ask-for-approval') -or $ca.StartsWith('--ask-for-approval=')) { $codexHasA = $true }; if ($ca -in @('-s','--sandbox') -or $ca.StartsWith('--sandbox=')) { $codexHasS = $true }; $codexCfg = $null; if (($ca -in @('-c','--config')) -and ($i + 1 -lt $nativeArgs.Count)) { $codexCfg = $nativeArgs[$i + 1] } elseif ($ca.StartsWith('--config=')) { $codexCfg = $ca.Substring(9) }; if ($null -ne $codexCfg) { if ($codexCfg -match '^approval_policy\\s*=') { $codexHasA = $true }; if ($codexCfg -match '^sandbox_mode\\s*=') { $codexHasS = $true } } }; if (-not $codexPreset) { $codexExtra = @(); if (-not $codexHasS) { $codexExtra += @('-s','workspace-write') }; if (-not $codexHasA) { $codexExtra += @('-a','on-request') }; if ($codexExtra.Count -gt 0) { $subIdx = [Array]::FindIndex([string[]]$nativeArgs, [Predicate[string]]{ param($x) $x -eq 'resume' -or $x -eq 'fork' }); if ($subIdx -ge 0) { $before = if ($subIdx -gt 0) { $nativeArgs[0..($subIdx - 1)] } else { @() }; $nativeArgs = @($before) + $codexExtra + @($nativeArgs[$subIdx..($nativeArgs.Count - 1)]) } else { $nativeArgs = @($nativeArgs) + $codexExtra } } } }; if ($nativeTask.agent -eq 'antigravity' -and $nativeTask.enabled -ne $false -and -not ($nativeArgs -contains '--dangerously-skip-permissions')) { $nativeArgs += '--dangerously-skip-permissions' }; if ($nativeTask.task -and $nativeTask.task.Trim()) { if ($nativeTask.agent -eq 'antigravity') { $nativeArgs += '--prompt-interactive' }; $nativeArgs += $nativeTask.task }; & $nativeArgv[0] @nativeArgs; exit $LASTEXITCODE"],
      { cwd: config.cwd, env: { ...childEnvironment(spawnEnv ?? env, "win32"), HERDR_UNATTENDED_TASK_FILE: resolve(configPath) }, windowsHide: true, stdio: "inherit" })
    : launch(argv[0], args, { cwd: config.cwd, ...(spawnEnv ? { env: spawnEnv } : {}), stdio: "inherit" });
  const controller = new AbortController();
  const closed = new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", code => { controller.abort(); resolve(code ?? 1); }); });
  const monitoring = observe(configPath, { waitForAgent: true, signal: controller.signal });
  try { return await closed; }
  finally { controller.abort(); await monitoring; process.off("SIGINT", keepParent); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const path = process.argv[process.argv.indexOf("--config") + 1];
  (process.argv.includes("--watch") ? watch(path) : native(path))
    .then(code => { process.exitCode = code; }).catch(error => { console.error(`[Herdr] ${error.message}`); process.exitCode = 1; });
}
