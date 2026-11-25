import { appendFileSync, readFileSync, existsSync, realpathSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { basename, dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Core } from "./core.mjs";
import { DOC, UUID, keyOf, managed, runLauncher } from "./model.mjs";

export function resolveAntigravityTranscript(sessionId, rawPath, userHome = homedir(), env = process.env) {
  const candidates = [];
  if (typeof rawPath === "string" && rawPath) {
    if (!sessionId || rawPath.includes(sessionId)) candidates.push(rawPath);
    const cliVariant = rawPath.replace(/([\\/]\.gemini[\\/])antigravity([\\/])/i, "$1antigravity-cli$2");
    if (cliVariant !== rawPath && (!sessionId || cliVariant.includes(sessionId))) candidates.push(cliVariant);
  }
  if (UUID.test(sessionId || "")) {
    const agyHome = env.ANTIGRAVITY_CLI_HOME || join(userHome, ".gemini", "antigravity-cli");
    candidates.push(join(agyHome, "brain", sessionId, ".system_generated", "logs", "transcript.jsonl"));
  }
  return candidates.find(p => existsSync(p)) || rawPath || "";
}

export function normalizePayload(agent, payload, userHome = homedir(), env = process.env) {
  if (agent !== "antigravity" || !payload || typeof payload !== "object") return payload || {};
  const sessionId = payload.conversationId || payload.conversation_id || payload.session_id || "";
  const rawTranscript = payload.transcriptPath || payload.transcript_path || "";
  return {
    ...payload,
    session_id: sessionId,
    transcript_path: resolveAntigravityTranscript(sessionId, rawTranscript, userHome, env),
    hook_event_name: payload.hookEventName || payload.hook_event_name,
    cwd: payload.cwd || payload.workspacePaths?.[0],
  };
}

// Fail closed if a transcript cannot establish a root conversation. Never
// infer a conversation from directory/mtime: several agents share one folder.
export function rootTranscript(agent, rawPayload, read = readPrefix) {
  const payload = agent === "antigravity" ? normalizePayload(agent, rawPayload) : rawPayload;
  if (!UUID.test(payload?.session_id || "") || !payload.transcript_path || payload.agent_id || payload.is_sidechain) return false;
  let content;
  try { content = read(payload.transcript_path); } catch { return false; }
  const lines = String(content).split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  if (agent === "codex") {
    const meta = lines.find(r => r.type === "session_meta")?.payload;
    return Boolean(meta && (meta.id || meta.session_id) === payload.session_id
      && !meta.forked_from_id?.subagent && !meta.parent_thread_id
      && [undefined, "user"].includes(meta.thread_source)
      && (typeof meta.source === "string" || meta.source === undefined));
  }
  if (agent === "claude") return lines.some(r => r.sessionId === payload.session_id && !r.isSidechain && r.type === "user")
    && !lines.some(r => r.isSidechain);
  if (agent === "antigravity") {
    const first = lines.find(r => r.step_index === 0) ?? lines[0];
    return Boolean(first && first.type === "USER_INPUT" && first.source === "USER_EXPLICIT" && !lines.some(r => r.isSidechain));
  }
  return false;
}
function readPrefix(path) {
  const fd = openSync(path, "r");
  try { const buffer = Buffer.alloc(256 * 1024); return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8"); }
  finally { closeSync(fd); }
}
function matchesAgentBinary(name, command, agent) {
  if (agent === "antigravity") return name === "agy" || name === "antigravity";
  if (agent === "claude") return name === "claude" || name === "claude-code" || (name === "node" && /[\\/]@anthropic-ai[\\/]claude-code[\\/]/.test(command || ""));
  return name === agent;
}
export function rootProcess(terminalPid, hookPid, rows, agent) {
  const processes = new Map(rows.map(row => [row.pid, row]));
  let current = processes.get(hookPid), agents = 0;
  const visited = new Set();
  while (current && !visited.has(current.pid)) {
    visited.add(current.pid);
    const name = String(current.name).replace(/\.exe$/i, "").toLowerCase();
    // npm launchers are node, not a second native Codex process.
    if (matchesAgentBinary(name, current.command, agent)) agents++;
    if (current.pid === terminalPid) return agents === 1;
    current = processes.get(current.parent);
  }
  return false;
}
async function processRows() {
  const exec = promisify(execFile);
  if (process.platform === "win32") {
    const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath | ConvertTo-Json -Compress"], { windowsHide: true, timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
    return [].concat(JSON.parse(stdout)).map(r => ({ pid: r.ProcessId, parent: r.ParentProcessId, name: r.Name, command: r.CommandLine, executable: r.ExecutablePath }));
  }
  const { stdout } = await exec("ps", ["-e", "-o", "pid=,ppid=,comm=,args="], { timeout: 5000 });
  return stdout.trim().split("\n").map(line => { const [pid, parent, name, ...command] = line.trim().split(/\s+/); return { pid: +pid, parent: +parent, name: name.split("/").at(-1), command: command.join(" "), executable: name.startsWith("/") ? name : undefined }; });
}
export function resumedProcess(term, record, rows) {
  const flag = record.agent === "codex" ? "resume" : record.agent === "antigravity" ? "--conversation" : "--resume";
  for (const row of rows) {
    const name = String(row.name).replace(/\.exe$/i, "").toLowerCase();
    if (!matchesAgentBinary(name, row.command, record.agent)) continue;
    // Resume argv is generated by Herdr: an exact UUID, never --last or a title.
    const args = String(row.command).match(/(?:[^\s"]+|"[^"]*")+/g)?.map(s => s.replace(/^"|"$/g, "")) || [];
    const index = args.indexOf(flag);
    const inline = record.agent === "antigravity" && args.includes(`${flag}=${record.sessionId}`);
    if (!inline && (index < 1 || args[index + 1] !== record.sessionId)) continue;
    if (!rootProcess(term.pid, row.pid, rows, record.agent)) continue;
    return { pid: row.pid, executable: row.executable };
  }
  return null;
}
export const verifyResume = async (term, record) => resumedProcess(term, record, await processRows());
async function verifyProcess(term, agent) {
  const rows = await processRows();
  if (!rootProcess(term.pid, process.pid, rows, agent)) return false;
  const map = new Map(rows.map(r => [r.pid, r]));
  let current = map.get(process.pid);
  while (current) {
    const name = String(current.name).replace(/\.exe$/i, "").toLowerCase();
    if (matchesAgentBinary(name, current.command, agent)) return { executable: current.executable, pid: current.pid };
    if (current.pid === term.pid) break;
    current = map.get(current.parent);
  }
  return true;
}
export async function capture(core, agent, rawPayload, terminal = process.env.HC_TERMINAL_ID, verifyRoot = term => verifyProcess(term, agent)) {
  const payload = normalizePayload(agent, rawPayload);
  if (!/^t[0-9a-z]+$/.test(terminal || "") || !["SessionStart", "PreInvocation", "UserPromptSubmit", "Stop", "StatusLine"].includes(payload.hook_event_name)) return;
  if (!rootTranscript(agent, payload)) return;
  const term = await core.call("terminal.get", { terminal });
  if (!managed(term) || term.state !== "live") return;
  const verified = await verifyRoot(term);
  if (!verified) return;
  const server = await core.call("server.status");
  const generation = server.holder?.instance;
  if (!generation) return;
  const key = keyOf(term), now = Date.now();
  await core.update(DOC, doc => {
    doc ||= { version: 1, records: {} };
    doc.records ||= {};
    const previous = doc.records[key];
    // An old turn completing after /fork must not overwrite the new session.
    if (previous && previous.sessionId !== payload.session_id && !["SessionStart", "PreInvocation", "StatusLine"].includes(payload.hook_event_name)
      && !previous.closed && (!verified.pid || previous.agentPid === verified.pid)) return;
    // Remember an explicit launcher while its run descriptor still describes
    // this session; a continuation keeps it when the descriptor is gone.
    const launcher = runLauncher(term.labels?.["herdr.unattended.control"], agent)
      ?? (previous?.sessionId === payload.session_id ? previous?.launcher : null) ?? null;
    doc.records[key] = { ...previous, key, terminal, created: term.created_ms, pid: term.pid, generation, launcher,
      attempt: previous?.sessionId === payload.session_id ? previous.attempt : null,
      agent, agentPid: verified.pid, executable: verified.executable || previous?.executable, sessionId: payload.session_id, transcript: payload.transcript_path, cwd: payload.cwd || term.cwd,
      captured: now, closed: false, enabled: previous?.enabled !== false, state: "ready", error: null,
      unattended: term.labels?.["herdr.unattended"] === "on" || (previous?.state === "restoring" && previous.unattended) || false,
      unattendedControl: term.labels?.["herdr.unattended.control"] || previous?.unattendedControl || null };
    if (doc.uncaptured) delete doc.uncaptured[key];
    return doc;
  });
}
// The provider calls this before prompting. An empty response delegates to
// its configured policy, including when the terminal or observer has exited.
export async function antigravityDecision(core, payload, terminal, verify = term => verifyProcess(term, "antigravity")) {
  const call = payload.toolCall;
  if (!/^t[0-9a-z]+$/.test(terminal) || !UUID.test(payload.conversationId || "")
    || (payload.rootConversationId && payload.rootConversationId !== payload.conversationId)
    || !call || typeof call.name !== "string" || !call.name || !call.args || typeof call.args !== "object") return {};
  const term = await core.call("terminal.get", { terminal });
  const control = term.labels?.["herdr.unattended.control"];
  if (term.address !== terminal || term.state !== "live" || term.labels?.["herdr.unattended"] !== "on"
    || !control || basename(control) !== "control.json") return {};
  const owner = await verify(term);
  if (!owner?.pid) return {};
  const directory = dirname(control);
  const state = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
  if ((state.agentPid && state.agentPid !== owner.pid) || state.agent !== "antigravity" || !state.native || !state.ready || !state.running || state.terminal !== terminal
    || state.sourceCreated !== term.created_ms || state.sourcePid !== term.pid || !Number.isFinite(state.updated)
    || Date.now() - state.updated > 15000 || !Number.isInteger(state.pid) || state.pid <= 0) return {};
  process.kill(state.pid, 0);
  const policy = JSON.parse(readFileSync(control, "utf8"));
  if (policy.enabled !== true || !Array.isArray(policy.exceptions) || policy.exceptions.some(v => typeof v !== "string")) return {};
  const context = JSON.stringify(call).toLowerCase();
  if (policy.exceptions.some(v => v.trim() && context.includes(v.trim().toLowerCase()))) return { decision: "force_ask" };
  if (["ask_question", "notify_user"].includes(call.name) || /(?:hand back|return control|交还控制|归还控制)/i.test(context)) return {};
  appendFileSync(join(directory, "events.jsonl"), JSON.stringify({ time: new Date().toISOString(), type: "decision",
    source: "automatic", kind: "antigravity/PreToolUse", terminal, conversation: payload.conversationId,
    tool: call.name, step: payload.stepIdx }) + "\n", { mode: 0o600 });
  return { decision: "auto_approve" };
}
// Older Node 20 releases lack import.meta.main. macOS may launch via /var, a symlink to /private/var.
if (import.meta.main ?? (process.argv[1] && existsSync(process.argv[1]) && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url)) {
  const agent = process.argv[2];
  const inTerminal = /^t[0-9a-z]+$/.test(process.env.HC_TERMINAL_ID || "");
  let parsed = null;
  if (inTerminal || agent === "antigravity") {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    if (text.trim()) { try { parsed = JSON.parse(text); } catch {} }
  }
  // Outside a core-owned terminal this hook does nothing, including no server start.
  const event = parsed?.hookEventName || parsed?.hook_event_name;
  let response = event === "Stop" ? { decision: "allow" } : {};
  if (inTerminal && parsed) {
    const core = new Core();
    try {
      if (agent === "antigravity" && event === "PreToolUse") response = await antigravityDecision(core, parsed, process.env.HC_TERMINAL_ID);
      else await capture(core, agent, parsed);
    }
    catch (error) {
      if (agent !== "antigravity") { console.error(`[Herdr session capture] ${error.message}`); process.exitCode = 1; }
    }
    finally { core.close(); }
  }
  // Antigravity hooks require a JSON response object on stdout.
  if (agent === "antigravity") {
    process.stdout.write(JSON.stringify(response) + "\n");
  }
}
