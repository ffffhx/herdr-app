// Provider history and terminal handoff stay in the mod, outside Herdr's core.
import { readdirSync, readFileSync, openSync, readSync, closeSync, statSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { startProcess, Requests } from "./transport.mjs";

const exec = promisify(execFile);
export const sessionIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
export function validateResume(agent, id) {
  if (typeof id !== "string" || !sessionIdPattern.test(id) || (agent === "claude" && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))) throw new Error("Invalid session ID");
  return id;
}
const sameFolder = (a, b) => process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);

async function codexRead(cwd, method, params) {
  let transport;
  const rpc = new Requests(message => transport.send(message));
  transport = startProcess("codex", { cwd, onMessage: m => rpc.receive(m), onError: () => rpc.close(), onExit: () => rpc.close() });
  try {
    await rpc.call("initialize", { clientInfo: { name: "herdr_history", version: "1.0.0" } });
    transport.send({ method: "initialized", params: {} });
    return await rpc.call(method, params);
  } finally { rpc.close(); transport.close(); }
}

export function claudeSessions(cwd, root = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")) {
  const directory = join(root, "projects", resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-"));
  let files;
  try { files = readdirSync(directory).filter(f => /^[0-9a-f-]{36}\.jsonl$/i.test(f)); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const sessions = [];
  for (const file of files) {
    const path = join(directory, file), fd = openSync(path, "r");
    try {
      const size = statSync(path).size, buffer = Buffer.alloc(Math.min(size, 131072));
      readSync(fd, buffer, 0, buffer.length, 0);
      const records = buffer.toString("utf8").split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      const first = records.find(r => r.type === "user" && !r.isMeta && !r.isSidechain && r.cwd && sameFolder(r.cwd, cwd));
      if (!first) continue;
      const content = first.message?.content;
      const preview = typeof content === "string" ? content : content?.filter(b => b.type === "text").map(b => b.text).join(" ");
      sessions.push({ id: file.slice(0, -6), title: (preview || file).slice(0, 180), updated: statSync(path).mtimeMs });
    } finally { closeSync(fd); }
  }
  return sessions.sort((a, b) => b.updated - a.updated);
}

export async function listSessions({ agent, cwd }) {
  if (!cwd) throw new Error("Choose the original working folder");
  if (agent === "claude") return claudeSessions(cwd);
  if (agent !== "codex") throw new Error("Unsupported agent");
  const result = [];
  let cursor;
  do {
    const page = await codexRead(cwd, "thread/list", { cwd, cursor, limit: 100, sortKey: "updated_at", modelProviders: [], sourceKinds: ["cli", "vscode", "appServer"] });
    result.push(...page.data.filter(t => t.cwd && sameFolder(t.cwd, cwd)).map(t => ({ id: t.id, title: t.name || t.preview || t.id, updated: t.updatedAt * 1000 })));
    cursor = page.nextCursor;
  } while (cursor && result.length < 500);
  return result;
}

export async function verifySession({ agent, cwd, resumeSessionId }) {
  validateResume(agent, resumeSessionId);
  if (agent === "codex") {
    const { thread } = await codexRead(cwd, "thread/read", { threadId: resumeSessionId });
    if (!thread.cwd || !sameFolder(thread.cwd, cwd)) throw new Error("Session belongs to a different working folder");
  } else if (!claudeSessions(cwd).some(s => s.id === resumeSessionId)) throw new Error("Saved Claude session was not found in this folder");
}

export async function hc(args) {
  const result = await exec(process.platform === "win32" ? "hc.exe" : "hc", [...args, "--json"], { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
  return JSON.parse(result.stdout);
}

export function sourceReady(current, source, agent) {
  if (!source || !/^t[0-9a-z]+$/.test(source.address) || current.address !== source.address || current.created_ms !== source.created_ms) throw new Error("Original terminal changed; open its menu again");
  if (current.state === "finished") return;
  const app = current.status?.app;
  if (!current.reported || (agent === "codex" ? app !== "codex" : !["claude", "claude-code"].includes(app))) throw new Error("Original terminal is no longer the selected agent");
  if (!["idle", "done", "blocked"].includes(current.status?.state)) throw new Error("The original agent is still working. Switch after this turn finishes.");
}

export async function handoff(config, call = hc, verify = verifySession) {
  await verify(config); // Missing history must never stop a working terminal.
  if (!config.source) return;
  const current = await call(["get", config.source.address]);
  sourceReady(current, config.source, config.agent);
  if (current.state === "finished") return;
  await call(["kill", config.source.address]);
  const stopped = await call(["get", config.source.address]);
  if (stopped.state !== "finished") throw new Error("Original terminal did not stop; the conversation was not resumed");
}

export function lockSession(agent, id, root) {
  validateResume(agent, id);
  mkdirSync(root, { recursive: true });
  const path = join(root, `${agent}-${id}.json`);
  // Do not silently remove stale leases: a child may outlive its supervisor.
  writeFileSync(path, JSON.stringify({ pid: process.pid, started: Date.now() }), { flag: "wx", mode: 0o600 });
  return () => unlinkSync(path);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  listSessions(JSON.parse(process.argv[2])).then(value => console.log(JSON.stringify(value))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
