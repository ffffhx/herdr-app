import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough, Writable } from "node:stream";
import { spawn } from "node:child_process";
import { handoff, sourceReady, lockSession, claudeSessions, validateResume } from "../defaults/mods/unattended/sessions.mjs";
import { commandFor, startProcess } from "../defaults/mods/unattended/transport.mjs";
import { run } from "../defaults/mods/unattended/runner.mjs";

const uuid = "bedde808-1c15-4fc4-b2fa-5b4ac37566e1";
const source = { address: "t9", created_ms: 123 };
const terminal = { ...source, reported: true, state: "live", status: { state: "idle", app: "codex" } };

function menuItems(all, visiblePanes, target) {
  const code = readFileSync(new URL("../defaults/mods/menu/main.js", import.meta.url), "utf8")
    .replace(/^import .*;\r?\n/gm, "").replace("export default class", "class");
  return new Function("View", "tr", "terminals", "panes", "spaces", `${code}; return items(arguments[5], null);`)(
    class {}, text => text, () => all, () => visiblePanes, () => [], target);
}

test("an inactive tab's switch targets its own agent and SSH space, not the focused tab", () => {
  const all = [
    { address: "t1", report: { app: "codex" }, cwd: "/active", argv: ["codex"] },
    { address: "remote/t9", report: { app: "claude-code" }, cwd: "/clicked", argv: ["claude"] },
  ];
  const rows = menuItems(all, [
    { tab: "active", terminal: "t1", focused: true },
    { tab: "clicked", terminal: "remote/t9", focused: false },
  ], { tab: "tab", target: { id: "clicked", space: "remote-space" } });
  const switches = rows.filter(row => row[2]?.mod === "unattended");
  assert.equal(switches.length, 1);
  assert.deepEqual(switches[0][2].props, { space: "remote-space", source: "remote/t9", agent: "claude", folder: "/clicked" });
  assert(rows.some(row => row[1] === "tab.close" && row[2].id === "clicked"));
});

test("split tab menu lists each eligible agent and excludes shells, mods and managed runners", () => {
  const all = [
    { address: "t1", report: { app: "codex" }, argv: ["codex"] },
    { address: "t2", report: { app: "claude-code" }, argv: ["claude"] },
    { address: "t3", report: { app: "codex" }, argv: ["node", "/mods/unattended/runner.mjs"] },
    { address: "t4", report: { app: "bash" }, argv: ["bash"] },
  ];
  const visiblePanes = [...all.map(t => ({ tab: "split", terminal: t.address })), { tab: "split", terminal: null, mod: "files" }];
  const switches = menuItems(all, visiblePanes, { tab: "tab", target: { id: "split", space: "s1" } }).filter(row => row[2]?.mod === "unattended");
  assert.deepEqual(switches.map(row => row[2].props.source), ["t1", "t2"]);
  assert(switches[0][0].includes("t1") && switches[1][0].includes("t2"));
  assert.equal(menuItems(all, visiblePanes, { tab: "tab", target: { id: "empty" } }).filter(row => row[2]?.mod === "unattended").length, 0);
});

for (const state of ["idle", "done", "blocked"]) test(`handoff of ${state} source verifies history before stopping and confirms exit`, async () => {
  const calls = []; let stopped = false;
  await handoff({ agent: "codex", source }, async args => {
    calls.push(args[0]);
    if (args[0] === "kill") stopped = true;
    return { ...terminal, state: stopped ? "finished" : "live", status: { ...terminal.status, state } };
  }, async () => { calls.push("verify"); });
  assert.deepEqual(calls, ["verify", "get", "kill", "get"]);
});

for (const update of [
  { created_ms: 124 }, { address: "t10" }, { reported: false },
  { status: { state: "idle", app: "bash" } }, { status: { state: "working", app: "codex" } },
]) test(`changed or active source is not stopped: ${JSON.stringify(update)}`, async () => {
  const calls = [];
  await assert.rejects(handoff({ agent: "codex", source }, async args => { calls.push(args[0]); return { ...terminal, ...update }; }, async () => {}));
  assert.deepEqual(calls, ["get"]);
});

test("missing saved history never touches the source; failure to stop never resumes", async () => {
  await assert.rejects(handoff({ source }, () => assert.fail("must not call hc"), async () => { throw new Error("missing history"); }), /missing history/);
  await assert.rejects(handoff({ source, agent: "codex" }, async () => terminal, async () => {}), /did not stop/);
  assert.doesNotThrow(() => sourceReady({ ...terminal, state: "finished" }, source, "codex"));
});

test("resume leases prevent duplicate writers and are reusable only after release", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-lease-"));
  const release = lockSession("codex", "thread-test", root);
  assert.throws(() => lockSession("codex", "thread-test", root), /EEXIST/);
  release(); lockSession("codex", "thread-test", root)();
});

test("Claude resumes an exact UUID without a fork or latest-session fallback; shell syntax is rejected", () => {
  const args = commandFor("claude", uuid)[1];
  assert.deepEqual(args.slice(-2), ["--resume", uuid]);
  assert(!args.includes("--fork-session")); assert(!args.includes("--continue"));
  assert(!commandFor("claude")[1].includes("--resume"));
  for (const id of ["", "--last", "a & whoami", "$(whoami)", "../file", null]) {
    assert.throws(() => commandFor("claude", id));
    assert.throws(() => validateResume("codex", id));
  }
});

test("Claude history excludes another cwd, subagents and partial JSON lines", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-history-"));
  const cwd = join(root, "work");
  const dir = join(root, "projects", resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const row = { type: "user", cwd, sessionId: uuid, message: { content: "Remember my earlier context" } };
  writeFileSync(join(dir, `${uuid}.jsonl`), `${JSON.stringify(row)}\n{"incomplete":`);
  writeFileSync(join(dir, `${uuid.replace(/^b/, "c")}.jsonl`), JSON.stringify({ ...row, cwd: root }));
  writeFileSync(join(dir, `${uuid.replace(/^b/, "d")}.jsonl`), JSON.stringify({ ...row, isSidechain: true }));
  const list = claudeSessions(cwd, root);
  assert.equal(list.length, 1); assert.equal(list[0].id, uuid); assert.equal(list[0].title, row.message.content);
});

for (const agent of ["codex", "claude"]) test(`${agent}: resumed runner keeps ID, records handoff, auto-approves, and releases lease`, { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-resume-")), directory = join(root, "run");
  mkdirSync(directory);
  const resumeSessionId = agent === "codex" ? "thread-test" : uuid;
  const config = join(directory, "task.json");
  writeFileSync(config, JSON.stringify({ agent, source, resumeSessionId, cwd: root, task: "test task" }));
  let handedOff = false, text = "";
  const input = new PassThrough(), output = new Writable({ write(chunk, _, done) { text += chunk; done(); } });
  const code = await run(config, { once: true, input, output,
    handoffSession: async config => { assert.equal(config.resumeSessionId, resumeSessionId); handedOff = true; },
    transportFactory: (engine, options) => {
      assert(handedOff); assert.equal(options.resumeSessionId, resumeSessionId);
      return startProcess(engine, { ...options, launch: () => spawn(process.execPath, [fileURLToPath(new URL("./fixtures/unattended-peer.mjs", import.meta.url)), engine, resumeSessionId], { stdio: ["pipe", "pipe", "pipe"] }) });
    },
  });
  input.end(); output.end(); assert.equal(code, 0, text);
  const state = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
  assert.equal(state.sessionId, resumeSessionId); assert.equal(state.resumedFrom, resumeSessionId);
  assert.equal(state.approvalCount, 2); assert.equal(state.status, "done");
  assert(!existsSync(join(root, "session-locks", `${agent}-${resumeSessionId}.json`)));
  assert.match(readFileSync(join(directory, "events.jsonl"), "utf8"), /"type":"handoff"/);
});

test("failed handoff is visible in state and never starts an agent", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-handoff-error-")), directory = join(root, "run");
  mkdirSync(directory);
  const config = join(directory, "task.json");
  writeFileSync(config, JSON.stringify({ agent: "codex", resumeSessionId: "thread-test", cwd: root, task: "continue" }));
  const input = new PassThrough(), output = new PassThrough();
  const code = await run(config, { input, output, handoffSession: async () => { throw new Error("still working"); }, transportFactory: () => assert.fail("must not start") });
  input.end(); output.end(); assert.equal(code, 1);
  const state = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
  assert.equal(state.running, false); assert.equal(state.status, "error"); assert.match(state.error, /still working/);
  assert(!existsSync(join(root, "session-locks", "codex-thread-test.json")));
});
