import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { native, nativeConfirmation, NativeApprovals, watch } from "../defaults/mods/unattended/native.mjs";
import { eventFilter, subscribeTerminal } from "../defaults/mods/unattended/events.mjs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";

test("native menu launch preserves arguments and leaves an empty conversation on Unix", async t => {
  const directory = mkdtempSync(join(tmpdir(), "herdr-native-command-")), path = join(directory, "task.json");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const argv of [undefined, ["/custom/codex", "--no-daemon", "--profile", "my profile"]]) {
    writeFileSync(path, JSON.stringify({ agent: "codex", argv, task: "", cwd: directory }));
    let observed = false;
    const code = await native(path, { platform: "linux", launch: (command, args, options) => {
      assert.equal(command, argv?.[0] ?? "codex");
      assert.deepEqual(args, argv?.slice(1) ?? []);
      assert.equal(options.cwd, directory);
      const child = new EventEmitter(); queueMicrotask(() => child.emit("exit", 0)); return child;
    }, observe: async (_path, options) => { observed = true; assert.equal(options.waitForAgent, true); } });
    assert.equal(code, 0); assert(observed);
  }
});

test("Windows native launch passes configured arguments and task text as literal data", { skip: process.platform !== "win32" }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "herdr-native-command-")), path = join(directory, "task.json");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const recorder = join(directory, "record.cjs"), output = join(directory, "args.json");
  writeFileSync(recorder, "require('node:fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));\n");
  for (const task of ["", "中文 `backticks` $(not-a-command) 'quotes'\nnext line"]) {
    const args = ["--no-daemon", "profile with spaces", "$(literal)"];
    writeFileSync(path, JSON.stringify({ agent: "codex", argv: [process.execPath, recorder, output, ...args], task, cwd: directory }));
    let stderr = "", observed = false;
    const code = await native(path, { launch: (command, argv, options) => {
      const child = spawn(command, argv, { ...options, stdio: ["ignore", "pipe", "pipe"] });
      child.stderr.on("data", data => { stderr += data; }); return child;
    }, observe: async () => { observed = true; } });
    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), [...args, ...(task ? [task] : [])]);
    assert(observed);
  }
});

// Native Codex 0.166.0 and Claude Code 2.1.312 cards captured on Windows.
const codex = `History remains above this card.
  Would you like to run the following command?

  Reason: Write the test file
  $ Set-Content native-proof.txt VERIFIED

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with Set-Content (p)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel`;
// Child-agent approvals in the parent Codex TUI include a thread navigation key.
const codexChild = `
  Would you like to run the following command?

  Thread: Agent (12a0c2d1a049)

  Environment: local

  $ node capture-agent-main.cjs

› 1. Yes, proceed (y)
  2. No, and tell Codex what to do differently (esc)
  Press enter to confirm or esc to cancel or o to open thread`;
const claude = `PowerShell command
  Set-Content native-proof.txt VERIFIED
 Do you want to proceed?
 > 1. Yes
   2. Yes, and always allow access to this folder
   3. No

 Esc to cancel · Tab to amend`;
const source = { address: "t7", created_ms: 1234, pid: 9876 };
const term = { ...source, state: "live", reported: true, status: { app: "codex", state: "blocked", kind: "permission" }, turn: 3, status_ms: 20 };

function harness({ agent = "codex", enabled = true, exceptions = [], mutate = () => {} } = {}) {
  const state = { term: structuredClone(term), screen: agent === "codex" ? codex : claude, policy: { enabled, exceptions }, calls: [], events: [] };
  state.term.status.app = agent === "codex" ? "codex" : "claude-code";
  const observer = new NativeApprovals({ agent, source, policy: () => state.policy, audit: e => state.events.push(e), settle: async () => mutate(state), call: async args => {
    state.calls.push(args);
    if (args[0] === "get") return structuredClone(state.term);
    if (args[0] === "read") { assert.deepEqual(args, ["read", "t7", "--lines", "0"]); return { text: state.screen }; }
    if (args[0] === "keys") { assert.equal(state.events.at(-1).type, "decision"); return {}; }
    assert.fail(`Unexpected terminal mutation: ${args}`);
  } });
  return { state, observer };
}

test("native permission cards choose a single once-only shortcut, never persistent permission", () => {
  assert.deepEqual(nativeConfirmation("codex", term, codex).keys, ["y"]);
  assert.deepEqual(nativeConfirmation("claude", term, claude).keys, ["1"]);
  for (const text of ["Yes", codex + "\n› draft", codex.replace("Press enter to confirm or esc to cancel", ""), codex.replace("› 1.", "  1."), claude.replace("> 1. Yes", "  1. Yes")]) {
    assert.equal(nativeConfirmation("codex", term, text), null);
    assert.equal(nativeConfirmation("claude", term, text), null);
  }
  for (const status of [{ state: "idle" }, { state: "working" }, { state: "blocked", kind: "question" }]) {
    assert.equal(nativeConfirmation("codex", { ...term, status }, codex), null);
  }
  assert.equal(nativeConfirmation("codex", term, codex.replace("Write the test file", "Please return control in ProfilePilot")), null);
});

test("Codex child-agent cards recognize thread navigation with LF, CRLF and wrapped footers", () => {
  for (const screen of [codexChild, codexChild.replaceAll("\n", "\r\n"), codexChild.replace(" or o to open thread", "\n  or o to open thread")]) {
    const request = nativeConfirmation("codex", term, screen);
    assert.deepEqual(request?.keys, ["y"]);
    assert.match(request.context, /Thread: Agent \(12a0c2d1a049\)/);
  }
});

test("Codex thread navigation does not permit unknown footers, drafts or manual selections", () => {
  for (const screen of [
    codexChild + "\n› draft",
    codexChild + " or a to always allow",
    codexChild.replace("or o to open thread", "or o to open settings"),
    codexChild.replace("› 1.", "  1."),
    codexChild.replace("2. No, and tell Codex what to do differently (esc)", ""),
    codexChild.replace("node capture-agent-main.cjs", "Please return control in ProfilePilot"),
  ]) assert.equal(nativeConfirmation("codex", term, screen), null);
  assert.equal(nativeConfirmation("codex", { ...term, status: { state: "blocked", kind: "question" } }, codexChild), null);
});

test("Codex child-agent approvals are delivered and journaled once, with exceptions respected", async () => {
  const { state, observer } = harness(); state.screen = codexChild;
  assert.equal((await observer.tick()).approved, true);
  await observer.tick();
  assert.deepEqual(state.calls.filter(a => a[0] === "keys"), [["keys", source.address, "y"]]);
  assert.equal(state.events.length, 1);
  assert.match(state.events[0].request, /Thread: Agent \(12a0c2d1a049\)/);
  for (const options of [{ enabled: false }, { exceptions: ["capture-agent-main.cjs"] }, { exceptions: ["12a0c2d1a049"] }]) {
    const h = harness(options); h.state.screen = codexChild;
    await h.observer.tick();
    assert(!h.state.calls.some(a => a[0] === "keys"));
    assert.equal(h.state.events.length, 0);
  }
});

for (const agent of ["codex", "claude"]) test(`${agent}: enabling on a blocked native terminal approves once without stopping or clearing it`, async () => {
  const { observer, state } = harness({ agent });
  assert.equal((await observer.tick()).approved, true);
  await observer.tick();
  assert.equal(state.calls.filter(a => a[0] === "keys").length, 1);
  assert.equal(observer.approvalCount, 1);
  assert(!state.calls.some(a => ["kill", "interrupt", "send", "run"].includes(a[0])));
});

for (const [name, mutate] of Object.entries({
  "manual answer": s => { s.term.status.state = "working"; },
  "manual selection": s => { s.screen = s.screen.replace("› 1.", "  1."); },
  "a new turn": s => { s.term.turn++; },
  "a replacement process": s => { s.term.pid++; },
  "a recreated terminal": s => { s.term.created_ms++; },
  "a changed card": s => { s.screen = s.screen.replace("VERIFIED", "CHANGED"); },
  "disabled approval": s => { s.policy.enabled = false; },
  "a newly added exception": s => { s.policy.exceptions.push("Set-Content"); },
})) test(`native observer defers to ${name} before delivery`, async () => {
  const { observer, state } = harness({ mutate });
  await observer.tick();
  assert(!state.calls.some(a => a[0] === "keys"));
});

test("working, idle, drafts, disabled mode and exceptions never receive input", async () => {
  for (const status of ["idle", "working", "done"]) {
    const { observer, state } = harness(); state.term.status.state = status; state.screen = "› unfinished draft";
    await observer.tick(); assert.deepEqual(state.calls, [["get", "t7"]]);
  }
  for (const options of [{ enabled: false }, { exceptions: ["set-content"] }]) {
    const { observer, state } = harness(options); await observer.tick();
    assert(!state.calls.some(a => a[0] === "keys"));
  }
});

test("native launch leaves legacy configuration intact and makes a separate observer argv", async () => {
  const code = readFileSync(new URL("../defaults/mods/unattended/launch.js", import.meta.url), "utf8")
    .replace(/^import .*;\r?\n/gm, "").replaceAll("export async function", "async function");
  const writes = [], calls = [];
  const api = { appHome: () => "/home/test", writeTextFile: async (...args) => writes.push(args), exec: async (command, args) => {
    calls.push([command, ...args]); return { code: 0, stdout: command === "hc" ? '{"address":"t8"}' : "v22.1.0" };
  } };
  const { prepare, observe } = new Function(...Object.keys(api), `${code}; return {prepare, observe};`)(...Object.values(api));
  const entry = await prepare({ native: true, agent: "codex", source: { ...source, cwd: "/project" }, task: "Observe", cwd: "/project", exceptions: [] });
  assert.equal(JSON.parse(writes[0][1]).resumeOriginal, undefined);
  assert.equal(entry.argv[1], "/home/test/mods/unattended/native.mjs");
  assert(entry.argv.includes("--watch"));
  await observe(entry);
  assert.deepEqual(calls.at(-1).slice(0, 12), ["hc", "run", "--json", "--bg", "--no-notify", "--parent", "t7", "--rm", "--cwd", "/project", "--", "node"]);
});

test("switching closes only the confirmation overlay and preserves the native tab and pane", async () => {
  const code = readFileSync(new URL("../defaults/mods/unattended/main.js", import.meta.url), "utf8")
    .replace(/^import .*;\r?\n/gm, "").replace("export default class", "class");
  const entry = { id: "run", source, directory: "/run" }, observed = [], closed = [], saved = [];
  const api = { View: class {}, tr: s => s, props: () => ({ sourceCreated: 1234, sourcePane: "pane", overlay: "confirm" }),
    originalTerminal: async () => ({ ...source, cwd: "/project", app: "codex" }), prepare: async value => { assert.equal(value.native, true); assert.equal(value.resumeOriginal, undefined); return entry; },
    observe: async value => observed.push(value), shared: () => [], setShared: (...args) => saved.push(args),
    readTextFile: async () => JSON.stringify({ native: true, ready: true, running: true, terminal: "t7" }),
    closeOverlay: id => closed.push(id), run: () => assert.fail("must not create or close tabs/panes"), panes: () => assert.fail("must not change pane layout") };
  const Unattended = new Function(...Object.keys(api), `${code}; return Unattended;`)(...Object.values(api));
  const view = new Unattended(); Object.assign(view, { sourceAddress: "t7", agent: "codex" });
  const pending = []; const cx = { notify() {}, spawn: f => pending.push(f(cx)) };
  view.startSwitch(cx); await Promise.all(pending);
  assert.deepEqual(observed, [entry]); assert.equal(saved.length, 1);
  view.checkSwitch(cx); await Promise.all(pending);
  assert.deepEqual(closed, ["confirm"]); assert.equal(view.switched, true);
});

test("menu launches start unattended without a task or confirmation and keep errors retryable", async () => {
  const code = readFileSync(new URL("../defaults/mods/unattended/main.js", import.meta.url), "utf8")
    .replace(/^import .*;\r?\n/gm, "").replace("export default class", "class");
  for (const on of [null, "remote"]) for (const fail of [false, true]) {
    const prepared = [], runs = [], closed = [], pending = [], saved = new Map([["unattended.exceptions", ["publish"]]]);
    const entry = { agent: "codex", argv: ["node", "/runtime/native.mjs", "--config", "/run/task.json"] };
    const p = { overlay: "launch", space: "s1", agent: "codex", launch: ["codex", "--no-daemon"], name: "Custom Codex", folder: "/project/subfolder" };
    const input = { new: ({ value }) => ({ value: () => value, on() {} }) };
    const api = { View: class {}, InputState: input, TextareaState: input, tr: s => s, props: () => p,
      spaces: () => [{ id: "s1", machine: on }], shared: key => saved.get(key), setShared: (key, value) => saved.set(key, value),
      prepare: async config => { prepared.push(config); if (fail) throw new Error("Node.js unavailable"); return entry; },
      closeOverlay: id => closed.push(id), run: (...args) => runs.push(args) };
    const Unattended = new Function(...Object.keys(api), `${code}; return Unattended;`)(...Object.values(api));
    const view = new Unattended(); const cx = { notify() {}, focus_handle: () => ({}), spawn: f => pending.push(f(cx)) };
    view.init(p, cx);
    view.start(cx); // Repeated activation while preparing must not launch twice.
    await Promise.all(pending);
    assert.deepEqual(prepared, [{ agent: "codex", argv: p.launch, task: "", cwd: p.folder, exceptions: ["publish"], on, native: true }]);
    assert.equal(view.busy, false);
    if (fail) {
      assert.match(view.error, /Node.js unavailable/);
      assert.deepEqual(runs, []); assert.deepEqual(closed, []);
    } else {
      assert.deepEqual(runs, [["tab.new", { space: "s1", name: "Custom Codex", folder: p.folder, argv: entry.argv }]]);
      assert.deepEqual(closed, ["launch"]); assert.deepEqual(saved.get("unattended.runs"), [entry]);
    }
  }
});

test("native observer lifecycle labels the source, writes state, and never owns the agent process", async () => {
  const directory = mkdtempSync(join(tmpdir(), "herdr-native-test-")), path = join(directory, "task.json"), controller = new AbortController(), calls = [];
  writeFileSync(path, JSON.stringify({ agent: "codex", source, enabled: true }));
  await watch(path, { signal: controller.signal, subscribe: () => () => {}, call: async args => {
    calls.push(args);
    if (args[0] === "get") return { ...term, status: { app: "codex", state: "working" } };
    if (args[0] === "label") { if (args.includes("herdr.unattended=on")) controller.abort(); return {}; }
    assert.fail(`Must not mutate the original terminal: ${args}`);
  } });
  const state = JSON.parse(readFileSync(join(directory, "state.json")));
  assert.equal(state.terminal, "t7"); assert.equal(state.native, true); assert.equal(state.running, false);
  assert(calls.some(a => a.includes("herdr.unattended=on")));
  assert(calls.some(a => a.includes("herdr.unattended=off")));
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, message) {
  const deadline = Date.now() + 4000;
  while (!condition()) { assert(Date.now() < deadline, message); await sleep(10); }
}

async function runningObserver({ enabled = true, heartbeatMs = 30000, fallbackMs = 30000, initial = "working" } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "herdr-native-events-")), controller = new AbortController();
  const path = join(directory, "task.json"), calls = [];
  writeFileSync(path, JSON.stringify({ agent: "codex", source, enabled }));
  let hooks, closed = false;
  const state = { term: { ...term, status: { ...term.status, state: initial } }, screen: codex };
  const done = watch(path, { signal: controller.signal, heartbeatMs, fallbackMs, subscribe: (_address, callbacks) => {
    hooks = callbacks; hooks.connection(true); return () => { closed = true; };
  }, call: async args => {
    calls.push(args);
    if (args[0] === "get") return structuredClone(state.term);
    if (args[0] === "read") return { text: state.screen };
    if (args[0] === "keys") { state.term.status.state = "working"; hooks.change(); return {}; }
    if (args[0] === "label") return {};
    assert.fail(`Unexpected mutation: ${args}`);
  } });
  const read = () => JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
  await until(() => calls.filter(a => a[0] === "get").length >= 2, "observer did not start");
  return { state, calls, read, hooks, changePolicy(value) {
    const temporary = join(directory, "new-policy.json");
    writeFileSync(temporary, JSON.stringify({ enabled: value, exceptions: [] }));
    renameSync(temporary, join(directory, "control.json"));
  }, async stop() { controller.abort(); await done; assert(closed); } };
}

test("quiet observers neither poll the core nor rewrite unchanged state between heartbeats", async () => {
  const h = await runningObserver();
  try {
    const initial = h.read();
    await sleep(300);
    assert.equal(h.calls.filter(a => a[0] === "get").length, 2);
    assert.equal(h.calls.filter(a => a[0] === "read").length, 0);
    assert.equal(h.read().updated, initial.updated);
  } finally { await h.stop(); }
});

test("heartbeats keep state fresh without spawning status queries", async () => {
  const h = await runningObserver({ heartbeatMs: 80 });
  try {
    const initial = h.read().updated;
    await until(() => h.read().updated > initial, "no heartbeat");
    assert.equal(h.calls.filter(a => a[0] === "get").length, 2);
  } finally { await h.stop(); }
});

test("permission events wake immediately; delayed card painting gets a bounded retry", async () => {
  const h = await runningObserver();
  try {
    h.state.term.status.state = "blocked"; h.state.screen = "Still painting";
    h.hooks.change();
    await until(() => h.calls.some(a => a[0] === "read"), "permission event was missed");
    h.state.screen = codex;
    await until(() => h.calls.some(a => a[0] === "keys"), "settling retry did not approve");
    for (let i = 0; i < 100; i++) h.hooks.change();
    await sleep(100);
    assert.equal(h.calls.filter(a => a[0] === "keys").length, 1);
    assert(h.calls.filter(a => a[0] === "get").length < 10, "burst was not coalesced");
  } finally { await h.stop(); }
});

test("unknown cards stop short retries and return to the fallback interval", async () => {
  const h = await runningObserver();
  try {
    h.state.term.status.state = "blocked"; h.state.screen = "An unknown permission UI"; h.hooks.change();
    await until(() => h.calls.filter(a => a[0] === "read").length >= 3, "settling checks missing");
    const count = h.calls.length;
    await sleep(400);
    assert.equal(h.calls.length, count); assert(!h.calls.some(a => a[0] === "keys"));
  } finally { await h.stop(); }
});

test("atomic policy changes wake the observer without waiting for fallback", async () => {
  const h = await runningObserver({ enabled: false, initial: "blocked" });
  try {
    h.changePolicy(true);
    await until(() => h.calls.some(a => a[0] === "keys"), "enabling policy did not wake the observer");
    h.changePolicy(false);
    await until(() => !h.read().enabled && h.calls.some(a => a.includes("herdr.unattended=off")), "disabling policy did not clear the badge");
    assert.equal(h.calls.filter(a => a[0] === "keys").length, 1);
  } finally { await h.stop(); }
});

test("lost events still discover approval through the low-frequency fallback", async () => {
  const h = await runningObserver({ fallbackMs: 80 });
  try {
    h.hooks.connection(false); h.state.term.status.state = "blocked";
    await until(() => h.calls.some(a => a[0] === "keys"), "fallback did not inspect the terminal");
    assert.equal(h.read().monitoring, "fallback");
  } finally { await h.stop(); }
});

test("event filtering ignores unrelated activity, duplicate status and our badge writes", () => {
  const accepts = eventFilter("t7");
  const event = (seq, type, data, terminal = "t7") => ({ method: "event", params: { seq, type, data, terminal } });
  assert(accepts({ seq: 20, terminals: [] }));
  assert(!accepts(event(21, "status", term, "t8")));
  assert(accepts(event(22, "status", { reported: true, status: term.status })));
  assert(!accepts(event(23, "status", { reported: true, status: term.status })));
  assert(!accepts(event(24, "labels", { labels: { "herdr.unattended": "on" } })));
  assert(!accepts(event(25, "title", { title: "spinner" })));
  assert(accepts(event(26, "finished", {})));
  assert(!accepts(event(19, "restarted", {})));
  assert(accepts({ method: "missed", params: { seq: 30, terminals: [] } }));
  assert(accepts(event(31, "status", { reported: true, status: term.status })));
});

test("event clients reconnect after exit, accept fresh snapshots and close their own process", async () => {
  const children = [], connections = []; let changes = 0;
  const stop = subscribeTerminal("t7", { change: () => changes++, connection: value => connections.push(value), retryMs: 20, launch: (program, args, options) => {
    assert.match(program, /^hc(?:\.exe)?$/); assert.deepEqual(args, ["events", "--json", "--terminal", "t7"]); assert.equal(options.windowsHide, true);
    const child = new EventEmitter(); Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), killed: false, kill() {
      if (this.killed) return; this.killed = true; this.stdout.end(); this.stderr.end(); this.emit("close", 0);
    } });
    children.push(child); return child;
  } });
  try {
    children[0].stdout.write('{"seq":5,"term'); children[0].stdout.write('inals":[]}\n');
    assert.equal(changes, 1); assert.deepEqual(connections, [true]);
    children[0].kill();
    await until(() => children.length === 2, "stream was not reconnected");
    children[1].stdout.write('{"seq":1,"terminals":[]}\n');
    assert.equal(changes, 2); assert.deepEqual(connections, [true, false, true]);
  } finally { stop(); }
  await sleep(50); assert.equal(children.length, 2); assert(children.every(c => c.killed));
});
