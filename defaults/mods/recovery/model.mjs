import { basename } from "node:path";

export const DOC = "herdr-agent-sessions";
export const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const agentOf = term => term.status?.app === "codex" ? "codex" : ["claude", "claude-code"].includes(term.status?.app) ? "claude" : null;
export const keyOf = term => `${term.address}:${term.created_ms}`;
export function shellOf(term) {
  const name = basename(String(term.foreground?.name || term.argv?.[0] || "").replaceAll("\\", "/")).replace(/\.exe$/i, "").toLowerCase();
  return ["powershell", "pwsh", "bash", "zsh", "sh", "dash", "fish", "ksh"].includes(name) ? name : null;
}
export const managed = term => /^t[0-9a-z]+$/.test(term.address) && Boolean(term.labels?.["herdr.space"]) && term.keep;
export function resumeArgv(record) {
  if (!UUID.test(record.sessionId)) throw new Error("The saved conversation ID is invalid");
  const program = record.executable || record.agent;
  if (basename(program.replaceAll("\\", "/")).replace(/\.exe$/i, "").toLowerCase() !== record.agent) throw new Error("The saved agent executable does not match the integration");
  if (record.agent === "codex") return [program, "--no-daemon", "resume", record.sessionId];
  if (record.agent === "claude") return [program, "--resume", record.sessionId];
  throw new Error("This agent does not have a verified resume integration");
}
export function commandLine(record, shell) {
  const argv = resumeArgv(record);
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
