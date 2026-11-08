import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eligible, keyOf, duplicateSessions, commandLine, emptyPrompt, DOC } from "../defaults/mods/recovery/model.mjs";
import { rootTranscript, rootProcess, resumedProcess, capture } from "../defaults/mods/recovery/hook.mjs";
import { mergeHooks, install } from "../defaults/mods/recovery/install.mjs";
import { Recovery, requestRetry } from "../defaults/mods/recovery/service.mjs";
import { recoveredEntry } from "../defaults/mods/unattended/recovery.mjs";
import { lockSession } from "../defaults/mods/unattended/sessions.mjs";
import { spawnSync } from "node:child_process";

const id = "12345678-1234-1234-1234-123456789abc";
const term = (extra = {}) => ({ address: "t1", created_ms: 1, pid: 20, cwd: tmpdir(), keep: true, state: "live", labels: { "herdr.space": "s1" }, argv: ["powershell.exe"], foreground: { name: "powershell.exe", pid: 20 }, ...extra });
const record = (extra = {}) => ({ key: "t1:1", terminal: "t1", created: 1, pid: 10, generation: "old", agent: "codex", sessionId: id, state: "ready", cwd: tmpdir(), ...extra });
class FakeCore {
  constructor(t = term(), r = record()) { this.term = t; this.doc = { version: 1, records: { [keyOf(t)]: r } }; this.calls = []; }
  async call(method, params = {}) {
    this.calls.push({ method, params });
    if (method === "terminal.get") return structuredClone(this.term);
    if (method === "terminal.list") return { terminals: [structuredClone(this.term)] };
    if (method === "server.status") return { holder: { instance: "new" } };
    if (method === "doc.get") return { value: structuredClone(this.doc), version: 1 };
    if (method === "terminal.read") return { text: this.screen ?? "PS C:\\test> " };
    if (method === "terminal.send" && this.failSend) throw new Error("no reply");
    return {};
  }
  async update(name, change) { assert.equal(name, DOC); const next = change(structuredClone(this.doc)); if (next !== undefined) this.doc = next; return structuredClone(this.doc); }
}

test("only a lost managed terminal with an exact original conversation can resume", () => {
  assert(eligible(term(), record(), "new"));
  for (const t of [term({ state: "finished" }), term({ keep: false }), term({ labels: {} }), term({ created_ms: 2 }), term({ status: { app: "codex" } }), term({ foreground: { name: "node.exe", pid: 21 } })]) assert(!eligible(t, record(), "new"));
  for (const r of [record({ closed: true }), record({ enabled: false }), record({ sessionId: "latest" }), record({ pid: 20, generation: "new" }), record({ attempt: { pid: 20, generation: "new" } })]) assert(!eligible(term(), r, "new"));
  assert(eligible(term(), record({ pid: 20 }), "new"), "reused OS PID after reboot is still loss");
});
test("duplicates, unrelated programs, shell injection and already-claimed input are rejected", () => {
  const rows = [term(), term({ address: "t2" })], records = { "t1:1": record(), "t2:1": record({ key: "t2:1" }) };
  assert(!eligible(rows[0], records["t1:1"], "new", duplicateSessions(records, rows)));
  assert.equal(commandLine(record(), "powershell"), `& 'codex' '--no-daemon' 'resume' '${id}'`);
  assert.equal(commandLine(record({ agent: "claude" }), "zsh"), `'claude' '--resume' '${id}'`);
  assert.throws(() => commandLine(record({ sessionId: "'; rm -rf /" }), "bash"));
  assert.throws(() => commandLine(record(), "cmd"));
});
test("root transcript and process ancestry exclude spawned agents and preserve forks", () => {
  const payload = { session_id: id, transcript_path: "/test" };
  const read = source => JSON.stringify({ type: "session_meta", payload: { id, source, thread_source: "user" } });
  assert(rootTranscript("codex", payload, () => read("cli")));
  assert(!rootTranscript("codex", payload, () => read({ subagent: "spawn" })));
  const rows = [{ pid: 1, parent: 0, name: "powershell.exe" }, { pid: 2, parent: 1, name: "codex.exe" }, { pid: 3, parent: 2, name: "node.exe" }];
  assert(rootProcess(1, 3, rows, "codex"));
  assert(!rootProcess(1, 5, [...rows, { pid: 4, parent: 3, name: "codex.exe" }, { pid: 5, parent: 4, name: "node.exe" }], "codex"));
});
test("hook setup preserves foreign settings, is idempotent, and keeps unreadable files intact", () => {
  const original = { permissions: { allow: ["Read"] }, hooks: { Stop: [{ hooks: [{ command: "echo herdr-recovery-hook.ps1", type: "command" }] }] } };
  const command = '"/test/herdr-recovery-hook.cmd"';
  const next = mergeHooks(original, command);
  assert.deepEqual(next.permissions, original.permissions);
  assert.equal(next.hooks.Stop[0].hooks[0].command, "echo herdr-recovery-hook.ps1");
  assert.deepEqual(mergeHooks(next, command), next);
  const home = mkdtempSync(join(tmpdir(), "herdr-config-")), root = join(home, "codex"); mkdirSync(root);
  writeFileSync(join(root, "hooks.json"), "broken-json");
  const result = install(home, { CODEX_HOME: root, CLAUDE_CONFIG_DIR: join(home, "absent") });
  assert.equal(result[0].state, "error");
  assert.equal(readFileSync(join(root, "hooks.json"), "utf8"), "broken-json");
});
test("parallel recovery and disconnects never replay an uncertain send", async () => {
  const home = mkdtempSync(join(tmpdir(), "herdr-recover-")), transcript = join(home, "thread.jsonl"); writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: { id, source: "cli" } }));
  const c = new FakeCore(term(), record({ transcript })); c.failSend = true;
  const recovery = new Recovery(c, home);
  await Promise.all([recovery.recover(c.term, c.doc.records["t1:1"], "new"), recovery.recover(c.term, c.doc.records["t1:1"], "new")]);
  assert.equal(c.calls.filter(c => c.method === "terminal.send").length, 1);
  assert.equal(c.doc.records["t1:1"].attempt.state, "unknown");
  await assert.rejects(requestRetry(c, "t1:1"), /unknown outcome/);
});
test("missing history preserves the original binding and permits explicit safe retry", async () => {
  const home = mkdtempSync(join(tmpdir(), "herdr-missing-"));
  const c = new FakeCore(term(), record({ transcript: join(home, "missing") })), recovery = new Recovery(c, home);
  await recovery.tick();
  assert.equal(c.calls.filter(c => c.method === "terminal.send").length, 0);
  assert.equal(c.doc.records["t1:1"].sessionId, id);
  assert.equal(c.doc.records["t1:1"].state, "failed");
  await requestRetry(c, "t1:1");
  assert.equal(c.doc.records["t1:1"].attempt, null);
});
test("closed agents remain closed and stale unattended indicators are removed", async () => {
  const home = mkdtempSync(join(tmpdir(), "herdr-state-"));
  const t = term({ state: "finished", labels: { "herdr.space": "s1", "herdr.unattended": "on" } });
  const c = new FakeCore(t), recovery = new Recovery(c, home);
  await recovery.tick();
  assert(c.doc.records["t1:1"].closed);
  assert(c.calls.some(c => c.method === "terminal.label" && c.params.labels["herdr.unattended"] === "off"));
  assert(!c.calls.some(c => c.method === "terminal.send"));
});

test("drafts, a changed working directory and mismatched history never receive resume commands", async () => {
  const home = mkdtempSync(join(tmpdir(), "herdr-draft-")), transcript = join(home, "thread.jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: { id, source: "cli" } }));
  for (const shell of ["powershell", "pwsh"]) {
    assert(emptyPrompt("PS C:\\work> ", shell));
    assert(!emptyPrompt("PS C:\\work> echo hello >", shell));
  }
  assert(emptyPrompt("user@mac work % ", "zsh"));
  assert(!emptyPrompt("user@mac work % echo >", "zsh"));
  for (const mode of ["draft", "cwd", "identity", "disabled"]) {
    const c = new FakeCore(term(), record({ transcript }));
    if (mode === "draft") c.screen = "PS C:\\work> unsubmitted text";
    if (mode === "cwd") c.term.cwd = home;
    if (mode === "identity") c.doc.records["t1:1"].sessionId = "87654321-1234-1234-1234-123456789abc";
    if (mode === "disabled") c.doc.enabled = false;
    await new Recovery(c, home).tick();
    assert(!c.calls.some(c => c.method === "terminal.send"), mode);
  }
});

test("hooks bind exact root IDs and confirm a resumed conversation without a replacement task", async () => {
  const home = mkdtempSync(join(tmpdir(), "herdr-capture-")), transcript = join(home, "thread.jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: { id, source: "cli" } }));
  const c = new FakeCore(term(), record({ state: "restoring", unattended: true, attempt: { pid: 20, generation: "new" } }));
  await capture(c, "codex", { session_id: id, transcript_path: transcript, hook_event_name: "SessionStart", cwd: home }, "t1", async () => true);
  assert.equal(c.doc.records["t1:1"].pid, 20);
  assert.equal(c.doc.records["t1:1"].state, "ready");
  assert(c.doc.records["t1:1"].unattended);
  const other = "87654321-1234-1234-1234-123456789abc";
  writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: { id: other, source: "cli" } }));
  await capture(c, "codex", { session_id: other, transcript_path: transcript, hook_event_name: "Stop" }, "t1", async () => true);
  assert.equal(c.doc.records["t1:1"].sessionId, id, "late Stop cannot replace a fork");
  await capture(c, "codex", { session_id: other, transcript_path: transcript, hook_event_name: "SessionStart" }, "t1", async () => true);
  assert.equal(c.doc.records["t1:1"].sessionId, other);
});

test("automatic approval restores the saved exception policy and respects a disabled policy", async () => {
  const home = mkdtempSync(join(tmpdir(), "herdr-observer-")), control = join(home, "control.json");
  const t = term({ status: { app: "codex" }, labels: { "herdr.space": "s1", "herdr.unattended.control": control } });
  for (const enabled of [true, false]) {
    writeFileSync(control, JSON.stringify({ enabled, exceptions: ["git push"] }));
    const c = new FakeCore(t, record({ pid: 20, generation: "new", unattended: true, unattendedControl: control, attempt: { pid: 20, generation: "new" } }));
    await new Recovery(c, home).tick();
    const run = c.calls.find(c => c.method === "terminal.run");
    assert.equal(Boolean(run), enabled);
    if (run) assert.deepEqual(JSON.parse(readFileSync(run.params.argv.at(-1), "utf8")).exceptions, ["git push"]);
  }
});

test("a native exact-ID resume confirms recovery even when SessionStart is deferred", async () => {
  const rows = [{ pid: 20, parent: 0, name: "powershell.exe" }, { pid: 21, parent: 20, name: "codex.exe", command: `"C:\\Program Files\\codex.exe" --no-daemon resume ${id}` }];
  assert.equal(resumedProcess(term(), record(), rows).pid, 21);
  assert.equal(resumedProcess(term(), record({ sessionId: "87654321-1234-1234-1234-123456789abc" }), rows), null);
  assert.equal(resumedProcess(term({ pid: 100 }), record(), rows), null);
  const home = mkdtempSync(join(tmpdir(), "herdr-deferred-hook-"));
  const c = new FakeCore(term({ status: { app: "codex" } }), record({ state: "restoring", attempt: { pid: 20, generation: "new", at: 0 } }));
  await new Recovery(c, home, { verify: async (term, record) => resumedProcess(term, record, rows) }).tick();
  assert.equal(c.doc.records["t1:1"].state, "ready");
  assert.equal(c.doc.records["t1:1"].pid, 20);
  assert(!c.calls.some(c => c.method === "terminal.send"));
});

test("the unattended panel follows the recovered policy and retains previous journals", () => {
  const entry = { id: "task1", agent: "codex", directory: "/old/run" };
  const state = { native: true, terminal: "t1", sourceCreated: 1 };
  const records = [record({ unattendedControl: "/new/run/control.json" })];
  const next = recoveredEntry(entry, state, records);
  assert.equal(next.directory, "/new/run");
  assert.deepEqual(next.previousDirectories, ["/old/run"]);
  assert.equal(recoveredEntry(next, state, records), next);
  assert.equal(recoveredEntry(entry, { ...state, sourceCreated: 2 }, records), entry);
  const remote = { ...entry, on: "mac" };
  assert.equal(recoveredEntry(remote, state, records), remote);
});

test("lost-terminal recovery reclaims only dead native observer leases", () => {
  const home = mkdtempSync(join(tmpdir(), "herdr-lease-")), path = join(home, "native-t1-1.json");
  writeFileSync(path, JSON.stringify({ pid: process.pid, started: Date.now() }));
  assert.throws(() => lockSession("native", "t1-1", home, { reclaimDeadObserver: true }), /EEXIST/);
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true });
  writeFileSync(path, JSON.stringify({ pid: child.pid, started: Date.now() }));
  assert.throws(() => lockSession("native", "t1-1", home), /EEXIST/);
  const release = lockSession("native", "t1-1", home, { reclaimDeadObserver: true });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, process.pid);
  release();
});

test("hook launchers support spaces, apostrophes and Unicode on the running platform", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-hook-path-")), home = join(root, "app's 中文"), codex = join(root, "codex's 中文");
  mkdirSync(join(home, "mods/recovery"), { recursive: true }); mkdirSync(codex);
  writeFileSync(join(home, "mods/recovery/hook.mjs"), 'process.stdout.write(process.argv[2]);');
  const result = install(home, { CODEX_HOME: codex, CLAUDE_CONFIG_DIR: join(root, "missing") });
  assert.equal(result[0].state, "installed");
  const args = process.platform === "win32" ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(codex, "herdr-recovery-hook.ps1")] : [join(codex, "herdr-recovery-hook.sh")];
  const run = spawnSync(process.platform === "win32" ? "powershell.exe" : "sh", args, { encoding: "utf8", windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "codex");
});

test("a concurrently replaced conversation cancels pending input without overwriting the new binding", async () => {
  const home = mkdtempSync(join(tmpdir(), "herdr-race-")), transcript = join(home, "thread.jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: { id, source: "cli" } }));
  const c = new FakeCore(term(), record({ transcript })), call = c.call.bind(c);
  c.call = async (method, params) => {
    const result = await call(method, params);
    if (method === "terminal.read") c.doc.records["t1:1"] = record({ sessionId: "87654321-1234-1234-1234-123456789abc", attempt: null });
    return result;
  };
  await new Recovery(c, home).tick();
  assert(!c.calls.some(c => c.method === "terminal.send"));
  assert.equal(c.doc.records["t1:1"].state, "ready");
  assert.equal(c.doc.records["t1:1"].attempt, null);
});
