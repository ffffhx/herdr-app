import { appHome, exec, readTextFile, writeTextFile } from "herdr";

const FILES = ["runner.mjs", "adapters.mjs", "supervisor.mjs", "policy.mjs", "transport.mjs"];
const remoteCreate = "const fs=require('node:fs'),p=require('node:path'),os=require('node:os');const v=JSON.parse(process.argv[1]);const dir=p.join(os.homedir(),'.config','herdr-app','unattended-runs',v.id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(p.join(dir,'task.json'),JSON.stringify(v.config),{flag:'wx',mode:384});console.log(dir);";
const remoteWrite = "const fs=require('node:fs'),p=require('node:path');const v=JSON.parse(process.argv[1]);fs.writeFileSync(p.join(v.dir,v.file),v.text,{flag:'wx',mode:384});";
const remoteControl = "const fs=require('node:fs');const v=JSON.parse(process.argv[1]);if(fs.readFileSync(v.path,'utf8')!==v.expected)throw Error('Policy changed; refresh and try again');const tmp=v.path+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,v.text,{mode:384});fs.renameSync(tmp,v.path);";

async function checked(command, args, on) {
  const result = await exec(command, args, { on });
  if (result.code !== 0) throw new Error(result.stderr || `${command} failed (${result.code})`);
  return result.stdout.trim();
}

export async function prepare({ agent, task, cwd, exceptions, on }) {
  if (!["codex", "claude"].includes(agent) || !task.trim()) throw new Error("Choose an agent and enter a task");
  const version = await checked("node", ["--version"], on);
  if (Number(/^v(\d+)/.exec(version)?.[1] ?? 0) < 20) throw new Error("Node.js 20 or newer is required on the task machine");
  await checked(agent, ["--version"], on);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const config = { agent, task, cwd: cwd || undefined, enabled: true, exceptions };
  let directory, runner;
  if (on) {
    directory = await checked("node", ["-e", remoteCreate, JSON.stringify({ id, config })], on);
    for (const file of FILES) {
      const text = await readTextFile(`${appHome()}/mods/unattended/${file}`);
      if (text === null) throw new Error(`Missing unattended runtime: ${file}`);
      await checked("node", ["-e", remoteWrite, JSON.stringify({ dir: directory, file, text })], on);
    }
    runner = `${directory}/runner.mjs`;
  } else {
    directory = `${appHome()}/data/unattended/runs/${id}`;
    await writeTextFile(`${directory}/task.json`, JSON.stringify(config), null);
    runner = `${appHome()}/mods/unattended/runner.mjs`;
  }
  return { id, agent, task, directory, on: on ?? null, argv: ["node", runner, "--config", `${directory}/task.json`] };
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
