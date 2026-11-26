import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { UUID, PROFILE_ID, launcherArgv } from "./model.mjs";
import { codexLaunchArgs, codexOptions } from "../unattended/codex-args.mjs";

// Recover permission options only. A previous prompt, conversation ID or command
// must never become input to the resumed terminal.
export function codexRunOptions(control) {
  try {
    const task = JSON.parse(readFileSync(join(dirname(control), "task.json"), "utf8"));
    if (!task.native || task.agent !== "codex") return null;
    const args = task.source ? task.savedCodexOptions : (task.argv ?? ["codex"]).slice(1);
    if (!Array.isArray(args) || args.some(arg => typeof arg !== "string")) return null;
    const { custom, flags } = codexOptions(args);
    return custom && !flags.length ? null : flags;
  } catch { return null; }
}

export function resumeArgv(record, home = null, nodePath = process.execPath) {
  if (!UUID.test(record.sessionId)) throw new Error("The saved conversation ID is invalid");
  const launcher = launcherArgv(record.launcher, record.agent);
  if (launcher) return [...launcher, "--resume", record.sessionId];
  const program = record.executable || (record.agent === "antigravity" ? "agy" : record.agent);
  const base = basename(program.replaceAll("\\", "/")).replace(/\.exe$/i, "").toLowerCase();
  const expected = record.agent === "antigravity" ? ["agy", "antigravity"] : [record.agent];
  if (!expected.includes(base)) throw new Error("The saved agent executable does not match the integration");
  if (record.agent === "codex") {
    let enabled = record.unattended === true, exceptions;
    const options = enabled ? codexRunOptions(record.unattendedControl) : null;
    if (enabled && record.unattendedControl) {
      try {
        const policy = JSON.parse(readFileSync(record.unattendedControl, "utf8"));
        enabled = policy.enabled === true;
        if (options) exceptions = policy.exceptions;
      } catch { /* Missing policy cannot grant network access. */ }
    }
    const args = ["--no-daemon", ...(enabled && options ? options : [])];
    return [program, ...codexLaunchArgs(args, enabled, exceptions), "resume", record.sessionId];
  }
  if (record.agent === "claude") return [program, "--resume", record.sessionId];
  if (record.agent === "antigravity") {
    if (record.profile) {
      if (!PROFILE_ID.test(record.profile)) throw new Error("The saved Antigravity profile is invalid");
      if (!home) throw new Error("An app home is required to resume an isolated Antigravity profile");
      const runner = join(home, "mods", "antigravity-profiles", "runner.mjs");
      const args = [nodePath, runner, "--profile", record.profile];
      if (record.profileName) args.push("--name", String(record.profileName).trim().slice(0, 40));
      args.push("--home", home, "--", program, "--conversation", record.sessionId);
      return args;
    }
    return [program, "--conversation", record.sessionId];
  }
  throw new Error("This agent does not have a verified resume integration");
}
export function commandLine(record, shell, home = null, nodePath = process.execPath) {
  const argv = resumeArgv(record, home, nodePath);
  if (["powershell", "pwsh"].includes(shell)) return "& " + argv.map(s => "'" + s.replaceAll("'", "''") + "'").join(" ");
  if (["bash", "zsh", "sh", "dash", "fish", "ksh"].includes(shell)) return argv.map(s => "'" + s.replaceAll("'", "'\\''") + "'").join(" ");
  throw new Error("Automatic recovery is unavailable in this shell");
}
