import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync, openSync, fsyncSync, closeSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

export function atomic(path, value) { atomicText(path, JSON.stringify(value, null, 2) + "\n"); }
function atomicText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w", 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
}
export function mergeHooks(config, command) {
  if (!config || Array.isArray(config) || typeof config !== "object") throw new Error("Invalid agent hook configuration");
  const result = structuredClone(config);
  result.hooks ||= {};
  for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
    const groups = result.hooks[event] || [];
    if (!Array.isArray(groups)) throw new Error(`Invalid ${event} hooks`);
    // Remove only our own versioned helper, retaining all other user hooks.
    result.hooks[event] = groups.map(group => ({ ...group, hooks: group.hooks.filter(h => h.command !== command) })).filter(g => g.hooks.length);
    result.hooks[event].push({ ...(event === "SessionStart" ? { matcher: "startup|resume|clear|compact|fork" } : {}),
      hooks: [{ type: "command", command, timeout: 10 }] });
  }
  return result;
}
export function mergeAntigravityHooks(config, command) {
  if (!config || Array.isArray(config) || typeof config !== "object") throw new Error("Invalid agent hook configuration");
  const result = structuredClone(config);
  for (const [name, spec] of Object.entries(result)) {
    if (name === "herdr-recovery") continue;
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error(`Invalid ${name} hook group`);
    for (const event of ["SessionStart", "PreInvocation", "Stop"]) {
      if (spec[event] !== undefined && !Array.isArray(spec[event])) throw new Error(`Invalid ${name}.${event} hooks`);
    }
  }
  const handler = { type: "command", command, timeout: 10 };
  // Antigravity's PreToolUse hook requires an explicit decision (allow/deny/ask/force_ask);
  // returning {} is treated as a hard deny, which breaks non-unattended sessions.
  // Register only lifecycle capture hooks globally.
  result["herdr-recovery"] = { SessionStart: [handler], PreInvocation: [handler], Stop: [handler] };
  return result;
}
export function install(home, env = process.env, platform = process.platform, userHome = homedir(), onlyAgent) {
  const configured = { codex: env.CODEX_HOME, claude: env.CLAUDE_CONFIG_DIR, antigravity: env.ANTIGRAVITY_CONFIG_DIR };
  const defaults = { codex: join(userHome, ".codex"), claude: join(userHome, ".claude"), antigravity: join(userHome, ".gemini", "config") };
  const roots = { codex: configured.codex || defaults.codex, claude: configured.claude || defaults.claude, antigravity: configured.antigravity || defaults.antigravity };
  const canonical = target => { try { return realpathSync(target); } catch { return resolve(target); } };
  const samePath = (a, b) => platform === "win32" ? canonical(a).toLowerCase() === canonical(b).toLowerCase() : canonical(a) === canonical(b);
  const defaultHome = join(env.XDG_CONFIG_HOME || join(userHome, ".config"), "herdr-app");
  const isolated = !samePath(home, defaultHome) || Boolean(env.HC_SESSION && env.HC_SESSION !== "default");
  const results = [];
  for (const [agent, root] of Object.entries(roots)) {
    if (onlyAgent && agent !== onlyAgent) continue;
    // A preview must not redirect the daily provider's shared hook launcher.
    // This also protects an explicitly inherited default provider directory.
    if (isolated && (!configured[agent] || samePath(root, defaults[agent]))) {
      results.push({ agent, state: "isolated", error: "An isolated Herdr instance requires its own agent configuration directory" }); continue;
    }
    if (!existsSync(root)) { results.push({ agent, state: "not-installed" }); continue; }
    const path = join(root, agent === "claude" ? "settings.json" : "hooks.json");
    try {
      // The provider can outlive any Herdr window or its installation directory.
      // Publish a complete, versioned helper beside its own configuration, then
      // switch the existing launcher. Never point it into a disposable app home.
      const files = ["hook.mjs", "core.mjs", "model.mjs"].map(name => [name, readFileSync(new URL(name, import.meta.url), "utf8")]);
      const version = createHash("sha256").update(JSON.stringify(files)).digest("hex");
      const runtime = join(root, "herdr-recovery", version);
      for (const [name, text] of files) {
        const target = join(runtime, name);
        if (!existsSync(target) || readFileSync(target, "utf8") !== text) atomicText(target, text);
      }
      const script = join(runtime, "hook.mjs");
      // Use a tiny stable launcher to avoid quoting a configurable home in the
      // provider's command shell. The helper path itself remains an argv value.
      const launcher = join(root, platform === "win32" ? "herdr-recovery-hook.ps1" : "herdr-recovery-hook.sh");
      if (platform === "win32" && /[%\r\n"]/u.test(script + launcher + process.execPath)) throw new Error("Unsupported characters in the recovery integration path");
      const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
      const ps = s => "'" + s.replaceAll("'", "''") + "'";
      // Windows PowerShell 5.1 needs a BOM for non-ASCII profile/app paths.
      const text = platform === "win32" ? `\uFEFF& ${ps(process.execPath)} ${ps(script)} ${agent}\r\nexit $LASTEXITCODE\r\n` : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} ${agent}\n`;
      const command = platform === "win32" ? `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${launcher}"` : `sh ${quote(launcher)}`;
      const original = existsSync(path) ? readFileSync(path, "utf8") : "{}";
      const merge = agent === "antigravity" ? mergeAntigravityHooks : mergeHooks;
      const config = merge(JSON.parse(original.replace(/^\uFEFF/, "")), command);
      if (!existsSync(launcher) || readFileSync(launcher, "utf8") !== text) atomicText(launcher, text);
      if (JSON.stringify(JSON.parse(original.replace(/^\uFEFF/, ""))) !== JSON.stringify(config)) {
        if (existsSync(path) && readFileSync(path, "utf8") !== original) throw new Error("Agent configuration changed during hook setup; reopen Herdr to retry");
        if (existsSync(path)) copyFileSync(path, `${path}.herdr-recovery-backup-${Date.now()}`);
        atomic(path, config);
      }
      results.push({ agent, state: "installed", path, runtime });
    } catch (error) { results.push({ agent, state: "error", error: error.message }); }
  }
  return results;
}

if (process.argv[2] === "--antigravity" && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const home = process.argv[3] || process.env.HERDR_APP_HOME || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "herdr-app");
  const [result] = install(home, process.env, process.platform, homedir(), "antigravity");
  if (result.state !== "installed") throw new Error(result.error || "Antigravity configuration directory not found");
}
