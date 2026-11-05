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
import { run as runAgent } from "../defaults/mods/unattended/runner.mjs";
import { identifySession, parseCodexStatus, claudeBinding } from "../defaults/mods/unattended/binding.mjs";
import { websocket, clientFrame } from "../defaults/mods/unattended/websocket.mjs";
import { createHash } from "node:crypto";
import { Codex } from "../defaults/mods/unattended/adapters.mjs";
const run = (path, options) => runAgent(path, { terminal: null, ...options });

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
  assert.deepEqual(switches[0][2].props, { space: "remote-space", source: "remote/t9", sourceCreated: undefined, sourcePane: undefined, agent: "claude" });
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

test("switch menu opens one restart confirmation for the clicked pane, without creating a form tab", () => {
  const code = readFileSync(new URL("../defaults/mods/menu/main.js", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "").replace("export default class", "class");
  const overlays = [], closed = [];
  const api = { View: class {}, tr: s => s, terminals: () => [{ address: "t9", report: { app: "codex" } }], panes: () => [{ pane: "p9", tab: "tb9", terminal: "t9" }], spaces: () => [], props: () => ({ tab: "tab", target: { id: "tb9", space: "s9" }, overlay: "menu" }), closeOverlay: id => closed.push(id), openOverlay: options => overlays.push(options), run: () => assert.fail("must wait for consent") };
  const Menu = new Function(...Object.keys(api), `${code}; return Menu;`)(...Object.values(api));
  new Menu().choose(0, {});
  assert.deepEqual(closed, ["menu"]); assert.equal(overlays.length, 1);
  assert.equal(overlays[0].kind, "dialog"); assert.equal(overlays[0].mod, "unattended");
  assert.deepEqual(overlays[0].props, { space: "s9", source: "t9", sourceCreated: undefined, sourcePane: "p9", agent: "codex" });
});

test("shared Codex transport never forwards another thread's approvals", async () => {
  const host = { send() {}, request: () => assert.fail("another thread must not be approved") };
  const adapter = new Codex(host); adapter.thread = "selected";
  await adapter.receive({ id: 1, method: "item/commandExecution/requestApproval", params: { threadId: "someone-else", command: "do something" } });
  assert.deepEqual(commandFor("codex", "selected", true), ["codex", ["app-server", "proxy"]]);
  assert.deepEqual(commandFor("codex"), ["codex", ["app-server", "--listen", "stdio://"]]);
});

test("daemon WebSocket validates upgrade, queues requests, handles fragmented JSON and ping", () => {
  const input = new PassThrough(), written = [], received = [];
  const output = new Writable({ write(data, _, done) { written.push(Buffer.from(data)); done(); } });
  const ws = websocket(input, output, { message: m => received.push(m), error: e => assert.fail(e.message) });
  ws.send({ method: "initialize" }); assert.equal(written.length, 1);
  const key = /Sec-WebSocket-Key: (.+)\r/.exec(written[0].toString())[1];
  const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  input.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  assert.equal(written.length, 2); assert.equal(written[1][1] & 128, 128);
  // A fragmented {"ok":true}, with a ping between its fragments.
  input.write(Buffer.from('01067b226f6b223a8901788005747275657d', 'hex'));
  assert.deepEqual(received, [{ ok: true }]); assert.equal(written[2][0], 0x8a);
  ws.close(); input.end();
});

test("daemon WebSocket refuses a bad handshake and masks short and extended client frames", () => {
  for (const size of [3, 130, 66000]) {
    const payload = Buffer.alloc(size, 42), frame = clientFrame(1, payload);
    const extra = size < 126 ? 0 : size <= 65535 ? 2 : 8, offset = 2 + extra;
    assert.equal(frame[0], 0x81); assert.equal(frame[1] & 128, 128);
    const decoded = Buffer.from(frame.subarray(offset + 4));
    for (let i = 0; i < size; i++) decoded[i] ^= frame[offset + i % 4];
    assert.deepEqual(decoded, payload);
  }
  const input = new PassThrough(), output = new PassThrough(), errors = [];
  websocket(input, output, { message: () => assert.fail("bad upgrade"), error: e => errors.push(e.message) });
  input.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: wrong\r\n\r\n');
  input.end(); output.end(); assert.match(errors[0], /refused/);
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
  writeFileSync(config, JSON.stringify({ agent, source, resumeOriginal: true, cwd: root, task: "test task" }));
  let handedOff = false, identified = false, text = "";
  const labels = [];
  const input = new PassThrough(), output = new Writable({ write(chunk, _, done) { text += chunk; done(); } });
  const code = await run(config, { once: true, input, output,
    terminal: "t99", core: async args => { assert.deepEqual(args.slice(0, 2), ["label", "t99"]); labels.push(args[2]); },
    identify: async config => { assert(!config.resumeSessionId); identified = true; return { id: resumeSessionId, source }; },
    handoffSession: async config => { assert(identified); assert.equal(config.resumeSessionId, resumeSessionId); handedOff = true; },
    transportFactory: (engine, options) => {
      assert(handedOff); assert.equal(options.resumeSessionId, resumeSessionId);
      return startProcess(engine, { ...options, launch: () => spawn(process.execPath, [fileURLToPath(new URL("./fixtures/unattended-peer.mjs", import.meta.url)), engine, resumeSessionId], { stdio: ["pipe", "pipe", "pipe"] }) });
    },
  });
  input.end(); output.end(); assert.equal(code, 0, text);
  const state = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
  assert.equal(state.sessionId, resumeSessionId); assert.equal(state.resumedFrom, resumeSessionId);
  assert.equal(state.approvalCount, 2); assert.equal(state.status, "done");
  assert.deepEqual(labels, ["herdr.unattended=off", "herdr.unattended=on", "herdr.unattended=off"]);
  assert.equal(JSON.parse(readFileSync(config, "utf8")).resumeSessionId, resumeSessionId);
  assert(!existsSync(join(root, "session-locks", `${agent}-${resumeSessionId}.json`)));
  assert(!existsSync(join(root, "session-locks", `source-${agent}-t9-123.json`)));
  assert.match(readFileSync(join(directory, "events.jsonl"), "utf8"), /"type":"handoff"/);
});

const statusCard = id => `/status\n\n  >_ OpenAI Codex (v0.166.0)\n  Model: GPT\n  Directory: /work\n  Session: ${id}\n`;

test("Codex identity requires the native status card following the most recent command", () => {
  assert.equal(parseCodexStatus(statusCard(uuid)), uuid);
  assert.equal(parseCodexStatus(`Tool output: Session: ${uuid}`), null);
  assert.equal(parseCodexStatus(statusCard(uuid) + "\n/status\nStill loading"), null);
  assert.equal(parseCodexStatus(`Session: ${uuid}\n/status\n`), null);
  assert.equal(parseCodexStatus(`/status\n  Session: ${uuid}`), null);
});

test("Claude binding uses the clicked process tree, excludes stale records and prefers its parent session", () => {
  const processes = [{ pid: 20, parent: 10 }, { pid: 30, parent: 20 }, { pid: 40, parent: 1 }];
  const records = [
    { pid: 20, sessionId: uuid, startedAt: 150, kind: "interactive" },
    { pid: 30, sessionId: uuid.replace(/^b/, "c"), startedAt: 160 },
    { pid: 40, sessionId: uuid.replace(/^b/, "d"), startedAt: 170 },
  ];
  assert.equal(claudeBinding(10, processes, records, 100), uuid);
  assert.throws(() => claudeBinding(50, processes, records, 100), /Cannot identify/);
  assert.throws(() => claudeBinding(10, processes, records, 200), /Cannot identify/);
  assert.throws(() => claudeBinding(10, [...processes, { pid: 21, parent: 10 }], [...records, { ...records[0], pid: 21, sessionId: uuid.replace(/^b/, "e") }], 100), /multiple/);
});

test("confirmed Codex switch pauses only its source, clears the draft, and queries that agent", async () => {
  const calls = []; let paused = false, sent = false;
  const call = async args => {
    calls.push(args); assert.equal(args[1], source.address);
    if (args[0] === "interrupt") paused = true;
    if (args[0] === "send") sent = true;
    if (args[0] === "read") return { text: sent ? statusCard(uuid) : "earlier output" };
    return { ...terminal, pid: 10, turn: 4, title: "Chosen agent", status: { app: "codex", state: paused ? "idle" : "working" } };
  };
  const result = await identifySession({ source, agent: "codex" }, { call, sleep: async () => {}, daemon: async (_cwd, id) => { assert.equal(id, uuid); return true; } });
  assert.equal(result.codexProxy, true);
  assert.equal(result.id, uuid); assert.equal(result.source.pid, 10); assert.equal(result.source.turn, 4);
  assert.deepEqual(calls.filter(a => ["keys", "send"].includes(a[0])), [["keys", "t9", "ctrl+u"], ["send", "t9", "/status"]]);
  assert(!calls.some(a => a[0] === "kill"));
});

test("unchanged/stale status or replaced terminal fails without killing it", async () => {
  const calls = [];
  await assert.rejects(identifySession({ source, agent: "codex" }, { sleep: async () => {}, call: async args => {
    calls.push(args[0]); return args[0] === "read" ? { text: statusCard(uuid) } : terminal;
  } }), /Cannot read/);
  assert(!calls.includes("kill"));
  await assert.rejects(identifySession({ source, agent: "codex" }, { call: async args => {
    assert.equal(args[0], "get"); return { ...terminal, created_ms: 124 };
  } }), /changed/);
});

test("a new turn or process after identification prevents stopping the source", () => {
  for (const update of [{ pid: 20 }, { turn: 5 }, { title: "different" }]) assert.throws(() =>
    sourceReady({ ...terminal, pid: 10, turn: 4, title: "same", ...update }, { ...source, pid: 10, turn: 4, title: "same" }, "codex"), /changed/);
});

test("identity failure releases the source lease without attempting handoff or resuming", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-identity-error-")), directory = join(root, "run");
  mkdirSync(directory);
  const config = join(directory, "task.json");
  writeFileSync(config, JSON.stringify({ agent: "codex", source, resumeOriginal: true, cwd: root, task: "continue" }));
  const input = new PassThrough(), output = new PassThrough();
  const code = await run(config, { input, output, identify: async () => { throw new Error("unknown session"); }, handoffSession: () => assert.fail("must not stop"), transportFactory: () => assert.fail("must not start") });
  input.end(); output.end(); assert.equal(code, 1);
  assert.match(JSON.parse(readFileSync(join(directory, "state.json"), "utf8")).error, /unknown session/);
  assert(!existsSync(join(root, "session-locks", "source-codex-t9-123.json")));
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
