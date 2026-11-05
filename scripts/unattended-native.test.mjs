import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeConfirmation, NativeApprovals, watch } from "../defaults/mods/unattended/native.mjs";

// Native Codex 0.166.0 and Claude Code 2.1.312 cards captured on Windows.
const codex = `History remains above this card.
  Would you like to run the following command?

  Reason: Write the test file
  $ Set-Content native-proof.txt VERIFIED

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with Set-Content (p)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel`;
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

test("native observer lifecycle labels the source, writes state, and never owns the agent process", async () => {
  const directory = mkdtempSync(join(tmpdir(), "herdr-native-test-")), path = join(directory, "task.json"), controller = new AbortController(), calls = [];
  writeFileSync(path, JSON.stringify({ agent: "codex", source, enabled: true }));
  await watch(path, { signal: controller.signal, call: async args => {
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
