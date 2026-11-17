// Local Antigravity CLI (agy) statusLine bridge. No account credentials, HTTP, or transcript reads.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");

const TTL = 60 * 60 * 1000;
const SIMPLE_TOKEN = /^[A-Za-z0-9_./:@+-]+$/;

function appHome(env = process.env, userHome = os.homedir()) {
  return env.HERDR_APP_HOME || path.join(env.XDG_CONFIG_HOME || path.join(userHome, ".config"), "herdr-app");
}
function agyHome(env = process.env, userHome = os.homedir()) {
  return env.ANTIGRAVITY_CLI_HOME || path.join(userHome, ".gemini", "antigravity-cli");
}
function canonicalPath(target) {
  try { return fs.realpathSync(target); } catch { return path.resolve(target); }
}
function samePath(a, b, platform = process.platform) {
  const left = canonicalPath(a), right = canonicalPath(b);
  return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
const load = file => JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));

function identity(term) {
  return /^t[0-9a-z]+$/.test(term?.address || "") && Number.isSafeInteger(term.pid) && term.pid > 0
    && Number.isSafeInteger(term.created_ms) && term.created_ms > 0
    ? `${term.address}-${term.pid}-${term.created_ms}` : null;
}
function recordPath(home, term) {
  const key = identity(term);
  return key ? path.join(home, "data", "antigravity-usage", `${key}.json`) : null;
}
function atomicText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}
const atomic = (file, value) => atomicText(file, JSON.stringify(value, null, 2) + "\n");

function hcExecutable(env = process.env, platform = process.platform, userHome = os.homedir()) {
  const binary = platform === "win32" ? "hc.exe" : "hc";
  const searchPath = env.PATH || env.Path || "";
  for (const raw of searchPath.split(platform === "win32" ? ";" : ":").filter(Boolean)) {
    const candidate = path.join(raw.replace(/^"|"$/g, ""), binary);
    if (fs.existsSync(candidate)) return candidate;
  }
  const fallbacks = platform === "win32"
    ? [path.join(env.LOCALAPPDATA || path.join(userHome, "AppData", "Local"), "Programs", "herdr-core", "hc.exe")]
    : [path.join(userHome, ".local", "bin", "hc"), "/opt/homebrew/bin/hc", "/usr/local/bin/hc"];
  return fallbacks.find(candidate => fs.existsSync(candidate)) || binary;
}

function nodeToken(env = process.env, platform = process.platform, execPath = process.execPath) {
  const binary = platform === "win32" ? "node.exe" : "node";
  const searchPath = env.PATH || env.Path || "";
  for (const raw of searchPath.split(platform === "win32" ? ";" : ":").filter(Boolean)) {
    if (fs.existsSync(path.join(raw.replace(/^"|"$/g, ""), binary))) return "node";
  }
  const normalized = String(execPath || "").replace(/\\/g, "/");
  return SIMPLE_TOKEN.test(normalized) ? normalized : "node";
}

function statusLineCommand(scriptPath, configPath, options = {}) {
  const node = nodeToken(options.env, options.platform, options.execPath);
  const script = String(scriptPath).replace(/\\/g, "/");
  const config = String(configPath).replace(/\\/g, "/");
  // Antigravity splits statusLine commands on whitespace without a shell. Keep
  // plain paths readable, and hex-encode bootstrap argv when a path has spaces.
  if (SIMPLE_TOKEN.test(node) && SIMPLE_TOKEN.test(script) && SIMPLE_TOKEN.test(config)) {
    return `${node} ${script} capture ${config}`;
  }
  const bootstrap = `require(${JSON.stringify(scriptPath)}).cli("capture",${JSON.stringify(configPath)});`;
  const hex = Buffer.from(bootstrap, "utf8").toString("hex");
  return `${SIMPLE_TOKEN.test(node) ? node : "node"} -e eval(Buffer.from('${hex}','hex').toString())`;
}

function isManagedCommand(command) {
  if (typeof command !== "string") return false;
  if (/[\\/]herdr-usage[\\/][0-9a-f]{16,64}[\\/]antigravity-usage\.cjs\s+capture(?:\s|$)/.test(command)) return true;
  const match = command.trim().match(/^\S+\s+-e\s+eval\(Buffer\.from\('([0-9a-f]+)','hex'\)\.toString\(\)\)$/);
  if (!match) return false;
  try {
    const decoded = Buffer.from(match[1], "hex").toString("utf8");
    return decoded.includes("herdr-usage") && decoded.includes("antigravity-usage.cjs") && decoded.includes('.cli("capture"');
  } catch { return false; }
}

function bucketMinutes(name) {
  const key = String(name || "").toLowerCase();
  if (/(?:^|-)weekly$|(?:^|-)7d$/.test(key)) return 10080;
  if (/(?:^|-)daily$|(?:^|-)24h$|(?:^|-)1d$/.test(key)) return 1440;
  const hours = key.match(/(?:^|-)(\d+)h$/);
  if (hours) return Number(hours[1]) * 60;
  const days = key.match(/(?:^|-)(\d+)d$/);
  if (days) return Number(days[1]) * 1440;
  const mins = key.match(/(?:^|-)(\d+)m$/);
  return mins ? Number(mins[1]) : null;
}

function preferredPool(model) {
  const text = `${model?.id || ""} ${model?.display_name || ""}`;
  return /\b(claude|gpt|oss|sonnet|opus|haiku)\b/i.test(text) && !/\b(gemini|orchestrator)\b/i.test(text) ? "3p" : "gemini";
}

function normalize(payload, now = Date.now()) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (payload.product !== undefined && payload.product !== "antigravity") return null;
  const wanted = preferredPool(payload.model);
  const quota = payload.quota;
  if (!quota || typeof quota !== "object" || Array.isArray(quota)) {
    return payload.product === "antigravity" ? { pool: wanted, windows: [], updatedAt: now } : null;
  }
  const groups = { gemini: [], "3p": [], default: [] };
  for (const [key, bucket] of Object.entries(quota)) {
    if (!bucket || typeof bucket !== "object" || bucket.disabled === true) continue;
    const fraction = bucket.remaining_fraction;
    if (typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue;
    let reset = typeof bucket.reset_time === "string" ? Date.parse(bucket.reset_time) : NaN;
    if (!Number.isFinite(reset) && typeof bucket.reset_in_seconds === "number" && Number.isFinite(bucket.reset_in_seconds) && bucket.reset_in_seconds > 0) {
      reset = now + bucket.reset_in_seconds * 1000;
    }
    const minutes = bucketMinutes(key);
    if (!Number.isFinite(reset) || reset <= now || !Number.isSafeInteger(minutes) || minutes <= 0) continue;
    const lower = key.toLowerCase();
    const group = lower.startsWith("gemini-") ? "gemini" : lower.startsWith("3p-") ? "3p" : "default";
    groups[group].push({ minutes, remaining: fraction * 100, resetsAt: reset });
  }
  const order = [wanted, "default", wanted === "3p" ? "gemini" : "3p"];
  const chosen = order.find(name => groups[name].length > 0) || wanted;
  const windows = (groups[chosen] || []).sort((a, b) => a.minutes - b.minutes);
  return { pool: chosen === "3p" ? "3p" : "gemini", windows, updatedAt: now };
}

function installStatusLine({ home, env = process.env, platform = process.platform, userHome = os.homedir(), execPath = process.execPath, sourceFile = __filename } = {}) {
  const targetHome = home || appHome(env, userHome);
  const defaultHome = path.join(env.XDG_CONFIG_HOME || path.join(userHome, ".config"), "herdr-app");
  const defaultAgy = path.join(userHome, ".gemini", "antigravity-cli");
  const root = agyHome(env, userHome);
  const isolated = !samePath(targetHome, defaultHome, platform) || Boolean(env.HC_SESSION && env.HC_SESSION !== "default");
  // An isolated preview must not rewrite the user's shared Antigravity settings.
  if (isolated && (!env.ANTIGRAVITY_CLI_HOME || samePath(root, defaultAgy, platform))) {
    return { state: "isolated" };
  }
  if (!fs.existsSync(root)) return { state: "not-installed" };
  const source = fs.readFileSync(sourceFile, "utf8");
  const version = crypto.createHash("sha256").update(source).digest("hex");
  const runtimeScript = path.join(root, "herdr-usage", version, "antigravity-usage.cjs");
  const configPath = path.join(root, "herdr-usage", "config.json");
  const settingsPath = path.join(root, "settings.json");
  const command = statusLineCommand(runtimeScript, configPath, { env, platform, execPath });
  const original = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf8") : "{}";
  const settings = JSON.parse(original.replace(/^\uFEFF/, ""));
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("Invalid Antigravity settings.json");
  let savedConfig = null;
  try { savedConfig = load(configPath); } catch {}
  const existing = settings.statusLine;
  const managed = existing && typeof existing === "object" && !Array.isArray(existing) && isManagedCommand(existing.command);
  const previous = managed
    ? (savedConfig?.previous?.type === "command" && typeof savedConfig.previous.command === "string" && !isManagedCommand(savedConfig.previous.command) ? savedConfig.previous : null)
    : (existing?.type === "command" && typeof existing.command === "string" && existing.command.trim() ? existing : null);
  const nextConfig = { version: 1, previous };
  const baseStatus = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  const nextStatus = previous
    ? { ...previous, type: "command", command }
    : { ...baseStatus, type: "command", command, stack_with_default: baseStatus.stack_with_default ?? true };
  if (!fs.existsSync(runtimeScript) || fs.readFileSync(runtimeScript, "utf8") !== source) {
    atomicText(runtimeScript, source);
  }
  if (!savedConfig || JSON.stringify(savedConfig) !== JSON.stringify(nextConfig)) {
    atomic(configPath, nextConfig);
  }
  if (JSON.stringify(existing) !== JSON.stringify(nextStatus)) {
    const current = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf8") : "{}";
    if (current !== original) throw new Error("Antigravity settings changed concurrently");
    if (fs.existsSync(settingsPath) && !managed) {
      fs.copyFileSync(settingsPath, `${settingsPath}.herdr-usage-backup-${Date.now()}`);
    }
    atomic(settingsPath, { ...settings, statusLine: nextStatus });
  }
  return { state: "installed", path: settingsPath, runtime: runtimeScript, configPath, command };
}

function capture(payload, { env = process.env, platform = process.platform, userHome = os.homedir(), now = Date.now(), term,
  core = args => JSON.parse(execFileSync(hcExecutable(env, platform, userHome), [...args, "--json"],
    { encoding: "utf8", env, windowsHide: true, timeout: 2500, maxBuffer: 1024 * 1024 })) } = {}) {
  if (!/^t[0-9a-z]+$/.test(env.HC_TERMINAL_ID || "")) return false;
  if (env.HC_SESSION && env.HC_SESSION !== "default" && !env.HERDR_APP_HOME) return false;
  const usage = normalize(payload, now);
  if (!usage) return false;
  term ||= core(["get", env.HC_TERMINAL_ID]);
  if (term?.address !== env.HC_TERMINAL_ID || term.state !== "live" || !identity(term)) return false;
  const home = appHome(env, userHome);
  atomic(recordPath(home, term), { version: 1, provider: "antigravity", pool: usage.pool, windows: usage.windows, updatedAt: usage.updatedAt });
  return true;
}

function readUsage(home, term, now = Date.now()) {
  const waiting = { provider: "antigravity", status: "waiting", windows: [] };
  if (!identity(term)) return waiting;
  let record;
  try { record = load(recordPath(home, term)); } catch { return waiting; }
  if (!record || record.version !== 1 || record.provider !== "antigravity") return waiting;
  const updated = record.updatedAt;
  if (!Number.isFinite(updated) || updated <= 0 || updated > now + 5000) return waiting;
  const pool = record.pool === "3p" ? "3p" : "gemini";
  if (now - updated > TTL) return { ...waiting, pool, status: "stale", updatedAt: updated };
  const windows = (Array.isArray(record.windows) ? record.windows : []).filter(w => Number.isSafeInteger(w?.minutes) && w.minutes > 0
    && typeof w.remaining === "number" && Number.isFinite(w.remaining) && w.remaining >= 0 && w.remaining <= 100
    && typeof w.resetsAt === "number" && Number.isFinite(w.resetsAt) && w.resetsAt > now);
  return { provider: "antigravity", pool, status: windows.length ? "ok" : "waiting", windows, updatedAt: updated };
}

function expandLeadingHome(command, userHome = os.homedir()) {
  return command.replace(/^~(?=[\\/])/, userHome);
}

function previousOutput(config, raw, { userHome = os.homedir(), platform = process.platform } = {}) {
  const previous = config?.previous;
  if (previous?.type !== "command" || typeof previous.command !== "string" || !previous.command.trim() || isManagedCommand(previous.command)) return;
  const command = expandLeadingHome(previous.command.trim(), userHome);
  const options = { input: raw, windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024, stdio: ["pipe", "pipe", "ignore"] };
  // Antigravity splits unquoted commands on whitespace; quoted/shell commands use the platform shell.
  const result = !/["'|&;<>()$`]/.test(command)
    ? (() => { const parts = command.split(/\s+/); return spawnSync(parts[0], parts.slice(1), options); })()
    : platform === "win32"
      ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${command}"`], { ...options, windowsVerbatimArguments: true })
      : spawnSync(command, { ...options, shell: true });
  if (result.stdout) process.stdout.write(result.stdout);
}

function cli(action = process.argv[2], configFile = process.argv[3]) {
  if (action === "capture") {
    let raw = Buffer.alloc(0);
    process.stdin.on("data", chunk => { if (raw.length + chunk.length <= 1024 * 1024) raw = Buffer.concat([raw, chunk]); else process.exit(0); });
    process.stdin.on("end", () => {
      let config;
      try { if (configFile) config = load(configFile); } catch {}
      try { capture(JSON.parse(raw.toString("utf8"))); } catch {}
      try { previousOutput(config, raw); } catch {}
    });
  } else if (action === "install") {
    try { process.stdout.write(JSON.stringify(installStatusLine()) + "\n"); }
    catch { process.stdout.write('{"state":"error"}\n'); }
  }
}

module.exports = {
  TTL, appHome, agyHome, identity, recordPath, statusLineCommand, isManagedCommand,
  bucketMinutes, preferredPool, normalize, installStatusLine, capture, readUsage, previousOutput, cli,
};

if (require.main === module) cli();
