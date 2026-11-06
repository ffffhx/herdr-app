import { appHome, exec, readTextFile, writeTextFile } from "herdr";

const FILES = ["native.mjs", "events.mjs", "runner.mjs", "adapters.mjs", "supervisor.mjs", "policy.mjs", "transport.mjs", "sessions.mjs", "binding.mjs", "websocket.mjs"];
// The host's direct exec does not resolve npm .cmd shims on Windows. Probe
// through Node with the same Windows PATH treatment as the session transport.
const probeCLI = `
const {spawnSync}=require('node:child_process'),{existsSync}=require('node:fs');
const agent=process.argv[1];
if(!['codex','claude'].includes(agent))process.exit(2);
const env={...process.env},win=process.platform==='win32';
if(win){
  const key=Object.keys(env).find(k=>k.toLowerCase()==='path'),seen=new Set();
  if(key)env[key]=env[key].split(';').filter(p=>{
    const normalized=p.toLowerCase();
    if(seen.has(normalized)||(p&&!existsSync(p.replace(/^"|"$/g,''))))return false;
    seen.add(normalized);return true;
  }).join(';');
}
const r=spawnSync(win?(process.env.ComSpec||'cmd.exe'):agent,win?['/d','/s','/c',agent+' --version']:['--version'],{env,encoding:'utf8',windowsHide:true,timeout:15000});
if(r.stdout)process.stdout.write(r.stdout);
if(r.stderr)process.stderr.write(r.stderr);
if(r.error)process.stderr.write(r.error.message);
process.exit(r.status??1);
`;
const remoteCreate = "const fs=require('node:fs'),p=require('node:path'),os=require('node:os');const v=JSON.parse(process.argv[1]);const dir=p.join(os.homedir(),'.config','herdr-app','unattended-runs',v.id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(p.join(dir,'task.json'),JSON.stringify(v.config),{flag:'wx',mode:384});console.log(dir);";
const remoteWrite = "const fs=require('node:fs'),p=require('node:path');const v=JSON.parse(process.argv[1]);fs.writeFileSync(p.join(v.dir,v.file),v.text,{flag:'wx',mode:384});";
const remoteControl = "const fs=require('node:fs');const v=JSON.parse(process.argv[1]);if(fs.readFileSync(v.path,'utf8')!==v.expected)throw Error('Policy changed; refresh and try again');const tmp=v.path+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,v.text,{mode:384});fs.renameSync(tmp,v.path);";

async function checked(command, args, on) {
  const result = await exec(command, args, { on });
  if (result.code !== 0) throw new Error(result.stderr || `${command} failed (${result.code})`);
  return result.stdout.trim();
}

export async function prepare({ agent, task, cwd, exceptions, on, resumeSessionId, source, resumeOriginal, native = false }) {
  if (!["codex", "claude"].includes(agent) || !task.trim()) throw new Error("Choose an agent and enter a task");
  const version = await checked("node", ["--version"], on);
  if (Number(/^v(\d+)/.exec(version)?.[1] ?? 0) < 20) throw new Error("Node.js 20 or newer is required on the task machine");
  await checked("node", ["-e", probeCLI, agent], on);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const config = { agent, task, cwd: cwd || undefined, enabled: true, exceptions,
    ...(native ? { native: true, ...(source ? { source } : {}) } : {}),
    ...(resumeSessionId ? { resumeSessionId, source } : {}), ...(resumeOriginal ? { resumeOriginal: true, source } : {}) };
  let directory, runner;
  if (on) {
    directory = await checked("node", ["-e", remoteCreate, JSON.stringify({ id, config })], on);
    for (const file of FILES) {
      const text = await readTextFile(`${appHome()}/mods/unattended/${file}`);
      if (text === null) throw new Error(`Missing unattended runtime: ${file}`);
      await checked("node", ["-e", remoteWrite, JSON.stringify({ dir: directory, file, text })], on);
    }
    runner = `${directory}/${native ? "native" : "runner"}.mjs`;
  } else {
    directory = `${appHome()}/data/unattended/runs/${id}`;
    await writeTextFile(`${directory}/task.json`, JSON.stringify(config), null);
    runner = `${appHome()}/mods/unattended/${native ? "native" : "runner"}.mjs`;
  }
  return { id, agent, task, directory, on: on ?? null, ...(native ? { native: true, source } : {}), ...(resumeSessionId ? { resumeSessionId, source } : {}), ...(resumeOriginal ? { resumeOriginal: true, source } : {}), argv: ["node", runner, ...(native && source ? ["--watch"] : []), "--config", `${directory}/task.json`] };
}

export async function observe(entry) {
  if (!entry.native || !entry.source) throw new Error("A native source terminal is required");
  return JSON.parse(await checked("hc", ["run", "--json", "--bg", "--no-notify", "--parent", entry.source.address,
    "--rm", "--cwd", entry.source.cwd, "--", ...entry.argv], entry.on));
}

export async function changeCurrent(source, enabled, on) {
  const path = source.controlPath;
  if (!path?.endsWith("/control.json") && !path?.endsWith("\\control.json")) throw new Error("No automatic approval observer is attached");
  const state = JSON.parse(await readTextFile(path.replace(/control\.json$/, "state.json"), { on }));
  if (!state.native || !state.running || state.terminal !== source.address || state.sourceCreated !== source.created_ms
    || Date.now() - state.updated > 15000) throw new Error("The automatic approval observer is no longer connected");
  await changePolicy({ directory: path.replace(/[/\\]control\.json$/, ""), on }, enabled);
}

export async function history({ agent, cwd, on }) {
  // Stage just the read-only history helper on SSH machines. Existing runs keep
  // their own runtime, and local history uses the installed mod directly.
  let script = `${appHome()}/mods/unattended/sessions.mjs`;
  if (on) {
    const id = `history-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const dir = await checked("node", ["-e", remoteCreate, JSON.stringify({ id, config: {} })], on);
    for (const file of ["sessions.mjs", "transport.mjs", "websocket.mjs"]) {
      const text = await readTextFile(`${appHome()}/mods/unattended/${file}`);
      if (text === null) throw new Error(`Missing unattended runtime: ${file}`);
      await checked("node", ["-e", remoteWrite, JSON.stringify({ dir, file, text })], on);
    }
    script = `${dir}/sessions.mjs`;
  }
  return JSON.parse(await checked("node", [script, JSON.stringify({ agent, cwd })], on));
}

export async function originalTerminal(address, on) {
  // exec(on) runs on the task machine: do not pass the machine prefix twice.
  const local = on && address.startsWith(`${on}/`) ? address.slice(on.length + 1) : address;
  if (!/^t[0-9a-z]+$/.test(local)) throw new Error("Invalid original terminal");
  const term = JSON.parse(await checked("hc", ["get", local, "--json"], on));
  return { address: term.address, created_ms: term.created_ms, pid: term.pid, cwd: term.cwd, app: term.status?.app,
    ...(term.labels?.["herdr.unattended.control"] ? { controlPath: term.labels["herdr.unattended.control"] } : {}) };
}

export async function changePolicy(entry, enabled) {
  const path = `${entry.directory}/control.json`;
  const expected = await readTextFile(path, { on: entry.on });
  if (expected === null) throw new Error("The task has not started yet");
  const value = JSON.parse(expected);
  const text = JSON.stringify({ ...value, enabled });
  if (entry.on) await checked("node", ["-e", remoteControl, JSON.stringify({ path, expected, text })], entry.on);
  else await writeTextFile(path, text, expected);
}
