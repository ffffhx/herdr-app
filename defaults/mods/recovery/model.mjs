import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const DOC = "herdr-agent-sessions";
export const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
// Explicit Claude entrypoints own the provider environment (and, for the
// official one, the exit guard). A resumed session must keep them.
const LAUNCHERS = ["claude-official", "claude-deepseek"];
const RESUME_ARGS = new Set(["--resume", "--continue", "-c", "-r", "--session-id", "--fork-session"]);

// Returns the saved launcher command only when it is exactly one of the
// explicit Claude entrypoints and does not already choose a conversation.
export function launcherArgv(argv, agent = "claude") {
  if (agent !== "claude" || !Array.isArray(argv) || !argv.length || argv.length > 8) return null;
  if (argv.some(arg => typeof arg !== "string" || !arg || arg.length > 260)) return null;
  const name = basename(String(argv[0]).replaceAll("\\", "/")).replace(/\.(cmd|ps1|exe)$/i, "").toLowerCase();
  if (!LAUNCHERS.includes(name)) return null;
  if (argv.slice(1).some(arg => RESUME_ARGS.has(arg.split("=")[0]))) return null;
  return [...argv];
}

// The unattended run that started a session records its argv beside its
// control document; recovered runs written by this version carry it too. The
// observer stops before recovery starts, so a saved run still describes the
// launcher its terminal used — that is the binding, not a guessed one.
export function runLauncher(control, agent = "claude") {
  if (typeof control !== "string" || !/[\\/]control\.json$/.test(control)) return null;
  const directory = dirname(control);
  try {
    const state = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
    if (state?.native !== true) return null;
    return launcherArgv(JSON.parse(readFileSync(join(directory, "task.json"), "utf8")).argv, agent);
  } catch { return null; }
}
export const agentOf = term => term.status?.app === "codex" ? "codex"
  : ["claude", "claude-code"].includes(term.status?.app) ? "claude"
  : ["antigravity", "agy"].includes(term.status?.app) ? "antigravity" : null;
export const keyOf = term => `${term.address}:${term.created_ms}`;
export function shellOf(term) {
  const name = basename(String(term.foreground?.name || term.argv?.[0] || "").replaceAll("\\", "/")).replace(/\.exe$/i, "").toLowerCase();
  return ["powershell", "pwsh", "bash", "zsh", "sh", "dash", "fish", "ksh"].includes(name) ? name : null;
}
export const managed = term => /^t[0-9a-z]+$/.test(term.address) && Boolean(term.labels?.["herdr.space"]) && term.keep;
export function resumeArgv(record, home = null, nodePath = process.execPath) {
  if (!UUID.test(record.sessionId)) throw new Error("The saved conversation ID is invalid");
  const launcher = launcherArgv(record.launcher, record.agent);
  if (launcher) return [...launcher, "--resume", record.sessionId];
  const program = record.executable || (record.agent === "antigravity" ? "agy" : record.agent);
  const base = basename(program.replaceAll("\\", "/")).replace(/\.exe$/i, "").toLowerCase();
  const expected = record.agent === "antigravity" ? ["agy", "antigravity"] : [record.agent];
  if (!expected.includes(base)) throw new Error("The saved agent executable does not match the integration");
  if (record.agent === "codex") return [program, "--no-daemon", "resume", record.sessionId];
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
// A shell process alone is insufficient: a person may have typed a draft.
// Unknown/custom prompts require an explicit retry after an empty standard prompt.
export function emptyPrompt(screen, shell) {
  const last = String(screen).replace(/\r/g, "").trimEnd().split("\n").at(-1);
  return ["powershell", "pwsh"].includes(shell) ? /^PS [^\n>]*>\s*$/.test(last)
    : /^[^$#%>\n]*[$#%>]\s*$/.test(last);
}
export function eligible(term, record, generation, duplicates = new Set()) {
  if (!record || !managed(term) || keyOf(term) !== record.key || term.state !== "live" || !term.pid) return false;
  if (record.closed || record.enabled === false || !UUID.test(record.sessionId)) return false;
  if (duplicates.has(`${record.agent}:${record.sessionId}`)) return false;
  if (agentOf(term) || !shellOf(term) || (term.foreground?.pid && term.foreground.pid !== term.pid)) return false;
  if (record.pid === term.pid && record.generation === generation) return false;
  // Claim before input. An interrupted or timed-out send is never replayed.
  return record.attempt?.generation !== generation || record.attempt?.pid !== term.pid;
}
export function duplicateSessions(records, live) {
  const counts = new Map();
  for (const term of live) {
    const r = records[keyOf(term)];
    if (!r || r.closed || r.enabled === false || term.state !== "live") continue;
    const key = `${r.agent}:${r.sessionId}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key));
}
