// Run only after the person confirms restarting the selected terminal.
// Session identity comes from that running agent, never from history ordering.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hc, validateResume, codexUsesDaemon } from "./sessions.mjs";

const exec = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const uuid = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";

export function checkSource(term, source, agent) {
  if (term.address !== source.address || term.created_ms !== source.created_ms || (source.pid && term.pid !== source.pid)) throw new Error("The selected terminal changed. Open its menu again.");
  const expected = agent === "codex" ? ["codex"] : ["claude", "claude-code"];
  if (term.state !== "live" || !term.reported || !expected.includes(term.status?.app)) throw new Error("The selected agent is no longer running.");
}

export function parseCodexStatus(text) {
  // Only the native /status card following the submitted command. A UUID in
  // ordinary model/tool output, a title or a previous conversation is not proof.
  const command = [...String(text).matchAll(/^\s*\/status\s*$/gm)].at(-1);
  if (!command) return null;
  const card = text.slice(command.index + command[0].length);
  if (!/>_ OpenAI Codex\s*\(v[^)]+\)/.test(card) || !/^\s*Model:/m.test(card) || !/^\s*Directory:/m.test(card)) return null;
  const match = new RegExp(`^\\s*Session:\\s*(${uuid})\\s*$`, "im").exec(card);
  return match?.[1] ?? null;
}

export function descendants(root, processes) {
  const depths = new Map([[root, 0]]);
  for (let n = 0; n < processes.length; n++) {
    let changed = false;
    for (const p of processes) if (!depths.has(p.pid) && depths.has(p.parent)) { depths.set(p.pid, depths.get(p.parent) + 1); changed = true; }
    if (!changed) break;
  }
  return depths;
}

export function claudeBinding(rootPid, processes, records, created = 0) {
  const depth = descendants(rootPid, processes);
  const candidates = records.filter(r => depth.has(r.pid) && typeof r.sessionId === "string" && (!created || r.startedAt >= created) && (!r.kind || r.kind === "interactive"));
  if (!candidates.length) throw new Error("Cannot identify the selected Claude session. The original terminal was not stopped.");
  const nearest = Math.min(...candidates.map(r => depth.get(r.pid)));
  const matches = candidates.filter(r => depth.get(r.pid) === nearest);
  if (new Set(matches.map(r => r.sessionId)).size !== 1) throw new Error("The selected terminal has multiple Claude sessions; cannot switch it automatically.");
  validateResume("claude", matches[0].sessionId);
  return matches[0].sessionId;
}

async function processes() {
  if (process.platform === "win32") {
    const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress"], { windowsHide: true, timeout: 15000 });
    const rows = JSON.parse(stdout);
    return (Array.isArray(rows) ? rows : [rows]).map(r => ({ pid: r.ProcessId, parent: r.ParentProcessId }));
  }
  const { stdout } = await exec("ps", ["-e", "-o", "pid=,ppid="], { timeout: 15000 });
  return stdout.trim().split("\n").map(line => { const [pid, parent] = line.trim().split(/\s+/).map(Number); return { pid, parent }; });
}

async function currentClaude(rootPid, created) {
  const root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "sessions");
  const records = [];
  try {
    for (const name of readdirSync(root).filter(n => /^\d+\.json$/.test(n))) {
      try { const r = JSON.parse(readFileSync(join(root, name), "utf8")); if (r.pid === Number(name.slice(0, -5))) records.push(r); } catch { /* An exiting process may remove its record. */ }
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return claudeBinding(rootPid, await processes(), records, created);
}

export async function identifySession(config, { call = hc, sleep = delay, claude = currentClaude, daemon = codexUsesDaemon } = {}) {
  const { source, agent } = config;
  let term = await call(["get", source.address]);
  checkSource(term, source, agent);
  // Restart confirmation also authorizes interrupting this one agent's turn.
  if (["working", "blocked"].includes(term.status.state)) {
    await call(["interrupt", source.address, "--timeout", "10"]);
    for (let n = 0; n < 40; n++) {
      term = await call(["get", source.address]); checkSource(term, source, agent);
      if (["idle", "done"].includes(term.status.state)) break;
      await sleep(250);
    }
    if (!["idle", "done"].includes(term.status.state)) throw new Error("The selected agent has not paused yet. It was not restarted.");
  }
  const identifiedTurn = term.turn, identifiedTitle = term.title;
  let id;
  if (agent === "claude") id = await claude(term.pid, source.created_ms);
  else {
    const before = (await call(["read", source.address, "--lines", "0"])).text;
    // The confirmed restart discards the TUI composer. Clear it before issuing
    // a built-in command so a draft cannot become an unintended model prompt.
    await call(["keys", source.address, "ctrl+u"]);
    await call(["send", source.address, "/status"]);
    for (let n = 0; n < 40; n++) {
      await sleep(250);
      const frame = (await call(["read", source.address, "--lines", "0"])).text;
      if (frame !== before && (id = parseCodexStatus(frame))) break;
    }
    if (!id) throw new Error("Cannot read this Codex session's ID. The original terminal was not stopped.");
  }
  validateResume(agent, id);
  const codexProxy = agent === "codex" && await daemon(config.cwd, id);
  term = await call(["get", source.address]); checkSource(term, source, agent);
  if (term.turn !== identifiedTurn || term.title !== identifiedTitle) throw new Error("The selected conversation changed while identifying it. Open its menu again.");
  return { id, codexProxy, source: { ...source, pid: term.pid, turn: term.turn, title: term.title } };
}
