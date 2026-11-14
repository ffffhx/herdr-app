// Local Claude Code statusLine bridge. No account credentials, HTTP, or transcript reads.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const TTL = 60 * 60 * 1000;
const appHome = (env = process.env) => env.HERDR_APP_HOME || path.join(os.homedir(), ".config", "herdr-app");
const load = file => JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
function identity(term) {
  return /^t[0-9a-z]+$/.test(term?.address || "") && Number.isSafeInteger(term.pid) && term.pid > 0
    && Number.isSafeInteger(term.created_ms) && term.created_ms > 0
    ? `${term.address}-${term.pid}-${term.created_ms}` : null;
}
function recordPath(home, term) {
  const key = identity(term);
  return key ? path.join(home, "data", "claude-usage", `${key}.json`) : null;
}
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}
function normalize(payload, now = Date.now()) {
  if (!UUID.test(payload?.session_id || "")) return null;
  const windows = [];
  for (const [key, minutes] of [["five_hour", 300], ["seven_day", 10080]]) {
    const value = payload.rate_limits?.[key], used = value?.used_percentage, reset = value?.resets_at;
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100
      || typeof reset !== "number" || !Number.isFinite(reset) || reset * 1000 <= now) continue;
    windows.push({ minutes, remaining: 100 - used, resetsAt: reset * 1000 });
  }
  return { sessionId: payload.session_id, windows, updatedAt: now };
}
function commandLine(args, platform = process.platform) {
  // Claude's command runner accepts quoted Windows paths; use slash paths so
  // Git Bash and cmd both preserve spaces. POSIX uses ordinary shell quoting.
  if (platform === "win32" && args.some(arg => /[%!$`"\r\n]/.test(String(arg)))) {
    throw new Error("Command path is not compatible with both Windows shells");
  }
  return args.map(arg => platform === "win32"
    ? '"' + String(arg).replace(/\\/g, "/").replace(/"/g, '\\"') + '"'
    : "'" + String(arg).replace(/'/g, "'\\''") + "'").join(" ");
}
function register(provider, { home = appHome(), env = process.env, previous = null, settingsFile = null, launcherPid = null, term,
  core = args => JSON.parse(execFileSync(process.platform === "win32" ? "hc.exe" : "hc", [...args, "--json"],
    { encoding: "utf8", env, windowsHide: true, timeout: 2500, maxBuffer: 1024 * 1024 })) } = {}) {
  if (!["official", "deepseek"].includes(provider) || !/^t[0-9a-z]+$/.test(env.HC_TERMINAL_ID || "")) return null;
  term ||= core(["get", env.HC_TERMINAL_ID]);
  if (term.address !== env.HC_TERMINAL_ID || term.state !== "live" || !identity(term)) return null;
  const launchId = crypto.randomUUID();
  const file = path.join(home, "data", "claude-usage", "sessions", `${launchId}.json`);
  const descriptor = path.join(home, "data", "claude-usage", "runtime", `${launchId}.json`);
  atomic(file, { version: 1, provider, launchId, launcherPid, active: true, sessionId: null, windows: [], updatedAt: null,
    ...(provider === "deepseek" && settingsFile ? { settingsFile } : {}) });
  atomic(descriptor, { file, launchId, previous: previous?.type === "command" ? previous : null });
  // Each launch writes its own snapshot. A late callback from an old launch
  // cannot overwrite the new launch even between a read and an atomic rename.
  atomic(recordPath(home, term), { launchId });
  try { core(["label", term.address, `herdr.claude.launch=${launchId}`]); } catch { /* Local collection still works. */ }
  return { descriptor, statusLine: { ...(previous || {}), type: "command",
    command: commandLine([process.execPath, __filename, "capture", descriptor]) } };
}
function capture(descriptor, payload, now = Date.now()) {
  const config = load(descriptor), current = load(config.file), usage = normalize(payload, now);
  if (!usage || current.launchId !== config.launchId || !current.active || current.provider !== "official") return false;
  atomic(config.file, { ...current, ...usage });
  return true;
}
function end(descriptor) {
  const config = load(descriptor), current = load(config.file);
  if (current.launchId === config.launchId) atomic(config.file, { ...current, active: false, windows: [] });
  fs.unlinkSync(descriptor);
}
function launcherProvider(argv) {
  if (!Array.isArray(argv) || !argv.length) return null;
  const name = String(argv[0]).replace(/\\/g, "/").split("/").pop().replace(/\.(cmd|ps1|exe)$/i, "").toLowerCase();
  return name === "claude-official" ? "official" : name === "claude-deepseek" ? "deepseek" : null;
}
function nativeProvider(home, term) {
  const direct = launcherProvider(term?.argv);
  if (direct) return direct;
  // Existing unattended sessions predate the bridge. Inspect their actual
  // launch configuration, bounded to this home's run directory, never a title.
  const control = term?.labels?.["herdr.unattended.control"];
  if (typeof control !== "string") return null;
  const directory = path.dirname(path.resolve(control));
  const root = path.resolve(home, "data", "unattended", "runs");
  const relative = path.relative(root, directory);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.basename(control) !== "control.json") return null;
  try {
    const state = load(path.join(directory, "state.json")), config = load(path.join(directory, "task.json"));
    if (!state.native || !state.running || state.sourceTerminal !== term.address || state.sourceCreated !== term.created_ms) return null;
    return config.native && config.agent === "claude" ? launcherProvider(config.argv) : null;
  } catch { return null; }
}
function readUsage(home, term, now = Date.now()) {
  const waiting = { provider: "claude-official", status: "waiting", windows: [] };
  if (!identity(term)) return { provider: "claude", status: "provider-unknown", windows: [] };
  let record;
  try {
    const pointer = load(recordPath(home, term));
    if (UUID.test(pointer.launchId || "")) {
      record = load(path.join(home, "data", "claude-usage", "sessions", `${pointer.launchId}.json`));
      if (record.launchId !== pointer.launchId) record = null;
    }
  } catch {}
  if (Number.isSafeInteger(record?.launcherPid) && record.launcherPid > 0) {
    try { process.kill(record.launcherPid, 0); } catch { record = null; }
  }
  if (!record?.active || record.version !== 1 || !UUID.test(record.launchId || "")) {
    const provider = nativeProvider(home, term);
    return provider === "official" ? waiting : { provider: provider || "claude", status: provider === "deepseek" ? "balance" : "provider-unknown", windows: [] };
  }
  if (record.provider === "deepseek") return { provider: "deepseek", status: "balance", windows: [], settingsFile: record.settingsFile };
  if (record.provider !== "official") return { provider: "claude", status: "provider-unknown", windows: [] };
  const updated = record.updatedAt;
  if (!UUID.test(record.sessionId || "") || !Number.isFinite(updated) || updated <= 0 || updated > now + 5000) return waiting;
  if (now - updated > TTL) return { ...waiting, status: "stale", updatedAt: updated };
  const windows = (Array.isArray(record.windows) ? record.windows : []).filter(w => [300, 10080].includes(w?.minutes)
    && typeof w.remaining === "number" && Number.isFinite(w.remaining) && w.remaining >= 0 && w.remaining <= 100
    && typeof w.resetsAt === "number" && Number.isFinite(w.resetsAt) && w.resetsAt > now);
  return { ...waiting, status: windows.length ? "ok" : "waiting", windows, updatedAt: updated };
}
function previousOutput(config, raw) {
  if (typeof config?.previous?.command !== "string" || !config.previous.command) return;
  // Preserve the user's existing statusLine. Windows .cmd needs cmd; POSIX
  // retains shell semantics. Only the original configured command is executed.
  const result = spawnSync(config.previous.command, { shell: true, input: raw, windowsHide: true,
    timeout: 5000, maxBuffer: 1024 * 1024, stdio: ["pipe", "pipe", "ignore"] });
  if (result.stdout) process.stdout.write(result.stdout);
}
module.exports = { TTL, identity, recordPath, normalize, commandLine, register, capture, end, nativeProvider, readUsage };
if (require.main === module) {
  const [action, argument] = process.argv.slice(2);
  if (action === "register") {
    try { process.stdout.write(JSON.stringify(register(argument, JSON.parse(fs.readFileSync(0, "utf8") || "{}")))); }
    catch { process.stdout.write("null"); }
  } else if (action === "capture") {
    let raw = Buffer.alloc(0);
    process.stdin.on("data", chunk => { if (raw.length + chunk.length <= 1024 * 1024) raw = Buffer.concat([raw, chunk]); else process.exit(0); });
    process.stdin.on("end", () => {
      let config;
      try { config = load(argument); capture(argument, JSON.parse(raw.toString("utf8"))); } catch {}
      previousOutput(config, raw);
    });
  } else if (action === "end") { try { end(argument); } catch {} }
}
