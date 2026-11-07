// A short-lived, read-only probe. Only normalized usage leaves this process;
// credentials and provider diagnostics never enter mod state or the UI.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");

function windowUsage(value, fallbackMinutes) {
  const used = value?.usedPercent ?? value?.utilization;
  if (typeof used !== "number" || !Number.isFinite(used)) return null;
  const rawReset = value.resetsAt ?? value.resets_at;
  const reset = typeof rawReset === "number" ? rawReset * 1000 : Date.parse(rawReset);
  const minutes = value.windowDurationMins;
  return {
    remaining: Math.max(0, Math.min(100, 100 - used)),
    minutes: typeof minutes === "number" && minutes > 0 && Number.isFinite(minutes) ? minutes : fallbackMinutes,
    resetsAt: Number.isFinite(reset) ? reset : null,
  };
}

function codexUsage(result) {
  // Prefer the general Codex bucket, never a random model-specific bucket.
  const limits = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits;
  const windows = [windowUsage(limits?.primary, 300), windowUsage(limits?.secondary, 10080)].filter(Boolean);
  return { status: windows.length ? "ok" : "unavailable", windows, updatedAt: Date.now() };
}

function claudeUsage(result) {
  const windows = [windowUsage(result?.five_hour, 300), windowUsage(result?.seven_day, 10080)].filter(Boolean);
  return { status: windows.length ? "ok" : "unavailable", windows, updatedAt: Date.now() };
}

function codexCommand(env = process.env, platform = process.platform) {
  const searchPath = env.PATH || env.Path || "";
  for (const directory of searchPath.split(platform === "win32" ? ";" : ":").filter(Boolean)) {
    const dir = directory.replace(/^"|"$/g, "");
    const exe = path.join(dir, platform === "win32" ? "codex.exe" : "codex");
    if (fs.existsSync(exe)) return { command: exe, args: ["app-server"] };
    // Windows npm shims cannot be spawned directly. Invoke their JS entry with
    // Node, without cmd.exe or interpolating paths into shell source.
    const js = path.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (platform === "win32" && fs.existsSync(path.join(dir, "codex.cmd")) && fs.existsSync(js)) {
      return { command: process.execPath, args: [js, "app-server"] };
    }
  }
  throw new Error("missing-cli");
}

function readCodex({ command, args } = codexCommand(), timeoutMs = 18000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: os.homedir(), windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    let done = false, buffer = "";
    const timer = setTimeout(() => finish(new Error("timeout")), timeoutMs);
    function finish(error, value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();
      // Close the probe's process tree only. npm's CLI entry spawns the native
      // app-server on Windows, where killing its Node parent alone leaks it.
      if (process.platform === "win32" && child.pid) {
        execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
      } else child.kill();
      if (error) reject(error); else resolve(value);
    }
    const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
    child.on("error", () => finish(new Error("missing-cli")));
    child.on("close", () => finish(new Error("unavailable")));
    child.stdin.on("error", () => finish(new Error("unavailable")));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) return finish(new Error("unavailable"));
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let reply;
        try { reply = JSON.parse(line); } catch { continue; }
        if (done) return;
        if (reply.id === 1) {
          if (reply.error) return finish(new Error("unavailable"));
          send({ method: "initialized", params: {} });
          send({ id: 2, method: "account/rateLimits/read", params: {} });
        } else if (reply.id === 2) {
          if (reply.error) {
            const message = String(reply.error.message || "");
            return finish(new Error(/auth|sign.in|log.in|401/i.test(message) ? "sign-in" : "unavailable"));
          }
          finish(null, codexUsage(reply.result));
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "herdr-quota", version: "1.0.0" } } });
  });
}

function deepseekBalance(result) {
  const amount = value => typeof value === "string" && value.length <= 32 && /^-?\d+(\.\d+)?$/.test(value) && Number.isFinite(Number(value)) ? value : null;
  const balances = (Array.isArray(result?.balance_infos) ? result.balance_infos : []).flatMap(info => {
    const total = amount(info?.total_balance);
    if (!["CNY", "USD"].includes(info?.currency) || total === null) return [];
    return [{ currency: info.currency, total, granted: amount(info.granted_balance), toppedUp: amount(info.topped_up_balance) }];
  });
  return { provider: "deepseek", status: balances.length ? "ok" : "unavailable", windows: [], balances, available: result?.is_available === true, updatedAt: Date.now() };
}

function claudeApi(env) {
  let url;
  try { url = new URL(env.ANTHROPIC_BASE_URL || "https://api.anthropic.com"); }
  catch { return { provider: "unsupported" }; }
  // Recognize only the official service. Never send a third-party gateway's
  // token to DeepSeek based on a model name or a hostname substring.
  if (url.origin === "https://api.deepseek.com" && !url.username && !url.password && /^\/(anthropic\/?|v1\/?|)?$/.test(url.pathname)) {
    return { provider: "deepseek", token: env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY };
  }
  if (url.origin !== "https://api.anthropic.com" || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_USE_BEDROCK === "1" || env.CLAUDE_CODE_USE_VERTEX === "1" || env.CLAUDE_CODE_USE_FOUNDRY === "1") {
    return { provider: "unsupported" };
  }
  return { provider: "claude" };
}

async function readDeepseek(token, request = fetch) {
  const failure = status => ({ provider: "deepseek", status, windows: [] });
  if (typeof token !== "string" || !token.trim()) return failure("api-key-missing");
  try {
    const response = await request("https://api.deepseek.com/user/balance", {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12000), redirect: "error",
    });
    if (!response.ok) return failure(response.status === 401 || response.status === 403 ? "api-key-invalid" : response.status === 429 ? "rate-limited" : "unavailable");
    return deepseekBalance(await response.json());
  } catch (error) {
    return failure(error.name === "TimeoutError" || error.name === "AbortError" ? "timeout" : "unavailable");
  }
}

async function readClaude({ env = process.env, platform = process.platform, home = os.homedir(), request = fetch } = {}) {
  const directory = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  let settings = {};
  try { settings = JSON.parse(await fs.promises.readFile(path.join(directory, "settings.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw new Error("unavailable"); }
  // Like Claude startup, apply the global settings environment to the inherited
  // environment. Per-terminal/project overrides are intentionally not inferred.
  const api = claudeApi({ ...env, ...settings?.env });
  if (api.provider === "deepseek") return readDeepseek(api.token, request);
  if (api.provider === "unsupported") return { status: "api-unsupported", windows: [] };
  let credentials;
  try { credentials = JSON.parse(await fs.promises.readFile(path.join(directory, ".credentials.json"), "utf8")); }
  catch {
    // Claude stores its default OAuth credentials in Keychain on macOS.
    // Custom config dirs must never silently fall back to another account.
    if (platform === "darwin" && !env.CLAUDE_CONFIG_DIR) {
      try {
        const { stdout } = await promisify(execFile)("/usr/bin/security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { timeout: 5000, maxBuffer: 1024 * 1024 });
        credentials = JSON.parse(stdout);
      } catch { throw new Error("sign-in"); }
    }
  }
  const token = credentials?.claudeAiOauth?.accessToken;
  if (typeof token !== "string" || !token) throw new Error("sign-in");
  const response = await request("https://api.anthropic.com/api/oauth/usage", {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.0" },
    signal: AbortSignal.timeout(12000), redirect: "error",
  });
  if (!response.ok) throw new Error(response.status === 401 ? "sign-in" : response.status === 429 ? "rate-limited" : "unavailable");
  return claudeUsage(await response.json());
}

async function completeCodexUsage(usage) {
  // Some CLI versions return only the weekly bucket. Orca fills the missing
  // short window from the usage endpoint using that same CLI account.
  if (usage.status !== "ok" || usage.windows.some(w => w.minutes < 1440)) return usage;
  try {
    const auth = JSON.parse(await fs.promises.readFile(path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "auth.json"), "utf8"));
    if (!auth.tokens?.access_token) return usage;
    const headers = { Authorization: `Bearer ${auth.tokens.access_token}` };
    if (auth.tokens.account_id) headers["ChatGPT-Account-Id"] = auth.tokens.account_id;
    const response = await fetch("https://chatgpt.com/backend-api/wham/usage", { headers, signal: AbortSignal.timeout(7000), redirect: "error" });
    if (!response.ok) return usage;
    const result = await response.json();
    const convert = w => w && ({ usedPercent: w.used_percent, windowDurationMins: w.limit_window_seconds / 60, resetsAt: w.reset_at });
    const complete = codexUsage({ rateLimits: { primary: convert(result.rate_limit?.primary_window), secondary: convert(result.rate_limit?.secondary_window) } });
    return complete.windows.some(w => w.minutes < 1440) ? complete : usage;
  } catch { return usage; }
}

module.exports = { windowUsage, codexUsage, claudeUsage, deepseekBalance, claudeApi, readDeepseek, codexCommand, readCodex, readClaude, completeCodexUsage };
if (require.main === module || !require.main) {
  const provider = process.argv[require.main ? 2 : 1];
  Promise.resolve().then(() => provider === "codex" ? readCodex().then(completeCodexUsage) : provider === "claude" ? readClaude() : { status: "unsupported", windows: [] })
    .catch((error) => ({ status: ["missing-cli", "timeout", "sign-in", "rate-limited", "unavailable"].includes(error.message) ? error.message : "unavailable", windows: [] }))
    .then((result) => process.stdout.write(JSON.stringify(result) + "\n"));
}
