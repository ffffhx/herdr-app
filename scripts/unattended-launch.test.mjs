import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

const source = readFileSync(new URL("../defaults/mods/unattended/launch.js", import.meta.url), "utf8")
  .replace(/^import .*;\r?\n/gm, "").replaceAll("export async function", "async function");

function harness({ remote = false, failAgent = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "herdr-launch-"));
  const calls = [];
  const api = {
    appHome: () => home,
    readTextFile: async path => existsSync(path) ? readFileSync(path, "utf8") : null,
    writeTextFile: async (path, text, expected) => {
      const actual = existsSync(path) ? readFileSync(path, "utf8") : null;
      assert.equal(actual, expected); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text);
    },
    exec: async (command, args, options) => {
      calls.push({ command, args, options });
      if (args[0] === "--version") return { code: failAgent && command === "codex" ? 1 : 0, stdout: command === "node" ? "v22.1.0" : "installed", stderr: failAgent ? "missing CLI" : "" };
      if (args[0] === "-e" && ["codex", "claude"].includes(args[2])) return { code: failAgent ? 1 : 0, stdout: failAgent ? "" : "installed", stderr: failAgent ? "missing CLI" : "" };
      assert(remote); assert.equal(options.on, "test-machine"); assert.equal(command, "node");
      const r = spawnSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } });
      return { code: r.status, stdout: r.stdout, stderr: r.stderr };
    },
  };
  const { prepare, changePolicy } = new Function(...Object.keys(api), `${source}; return {prepare, changePolicy};`)(...Object.values(api));
  return { home, calls, prepare, changePolicy };
}

test("local launcher creates an independent run and passes the task as data, not a shell argument", async () => {
  const { home, prepare } = harness();
  const task = "中文 task with `backticks`, $(commands), quotes \" and newlines\nnext line";
  const a = await prepare({ agent: "codex", task, cwd: home, exceptions: ["git push"] });
  const b = await prepare({ agent: "claude", task: "second task", cwd: home, exceptions: [] });
  assert.notEqual(a.directory, b.directory);
  assert(!a.argv.includes(task));
  assert.deepEqual(JSON.parse(readFileSync(join(a.directory, "task.json"), "utf8")), { agent: "codex", task, cwd: home, enabled: true, exceptions: ["git push"] });
  assert.equal(a.argv[0], "node"); assert.equal(a.argv[2], "--config");
});

test("CLI discovery resolves an installed launcher, including Windows npm shims and an oversized PATH", () => {
  const { probeCLI } = new Function(`${source}; return {probeCLI};`)();
  const directory = mkdtempSync(join(tmpdir(), "herdr-cli-probe-"));
  const win = process.platform === "win32";
  const file = join(directory, win ? "codex.cmd" : "codex");
  writeFileSync(file, win ? "@echo off\r\necho codex-test 1.0\r\n" : "#!/bin/sh\nprintf 'codex-test 1.0\\n'\n");
  if (!win) chmodSync(file, 0o755);
  const env = { ...process.env };
  const key = Object.keys(env).find(k => k.toLowerCase() === "path") ?? "PATH";
  env[key] = win ? `${Array.from({ length: 200 }, (_, i) => `${directory}/missing-${i}`).join(";")};${directory}` : directory;
  const result = spawnSync(process.execPath, ["-e", probeCLI, "codex"], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "codex-test 1.0");
});

test("missing agent prevents launch before a task directory is written", async () => {
  const { home, prepare } = harness({ failAgent: true });
  await assert.rejects(prepare({ agent: "codex", task: "task", cwd: home, exceptions: [] }), /missing CLI/);
  assert(!existsSync(join(home, "data")));
});

test("remote preparation copies a self-contained runtime and preserves literal Unicode task data", async () => {
  const { home, prepare, changePolicy } = harness({ remote: true });
  const files = ["runner.mjs", "adapters.mjs", "supervisor.mjs", "policy.mjs", "transport.mjs"];
  mkdirSync(join(home, "mods", "unattended"), { recursive: true });
  for (const file of files) writeFileSync(join(home, "mods", "unattended", file), readFileSync(new URL(`../defaults/mods/unattended/${file}`, import.meta.url)));
  const task = "远程任务：\"hello\"; $(do not execute)\nsecond line";
  const entry = await prepare({ agent: "claude", task, cwd: home, exceptions: ["发布"], on: "test-machine" });
  assert.equal(JSON.parse(readFileSync(join(entry.directory, "task.json"), "utf8")).task, task);
  for (const file of files) assert.equal(readFileSync(join(entry.directory, file), "utf8"), readFileSync(join(home, "mods", "unattended", file), "utf8"));
  writeFileSync(join(entry.directory, "control.json"), JSON.stringify({ enabled: true, exceptions: ["发布"] }));
  await changePolicy(entry, false);
  assert.deepEqual(JSON.parse(readFileSync(join(entry.directory, "control.json"), "utf8")), { enabled: false, exceptions: ["发布"] });
});
