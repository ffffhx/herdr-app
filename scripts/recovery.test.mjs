import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eligible, keyOf, duplicateSessions, commandLine, emptyPrompt, launcherArgv, runLauncher, DOC } from "../defaults/mods/recovery/model.mjs";
import { rootTranscript, rootProcess, resumedProcess, capture, resolveAntigravityTranscript } from "../defaults/mods/recovery/hook.mjs";
import { mergeHooks, mergeAntigravityHooks, install } from "../defaults/mods/recovery/install.mjs";
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
  assert.equal(commandLine(record({ agent: "antigravity" }), "powershell"), `& 'agy' '--conversation' '${id}'`);
  assert.equal(commandLine(record({ agent: "antigravity", executable: "D:\\Tools\\AntigravityCLI\\bin\\agy.exe" }), "powershell"), `& 'D:\\Tools\\AntigravityCLI\\bin\\agy.exe' '--conversation' '${id}'`);
  assert.throws(() => commandLine(record({ sessionId: "'; rm -rf /" }), "bash"));
  assert.throws(() => commandLine(record(), "cmd"));
});
test("an explicit Claude launcher is resumed as saved and never recombined with its own conversation flags", () => {
  const deepseek = ["C:\\Users\\me\\AppData\\Local\\npm\\claude-deepseek.cmd"];
  assert.deepEqual(launcherArgv(deepseek, "claude"), deepseek);
  assert.deepEqual(launcherArgv(["claude-official.ps1"], "claude"), ["claude-official.ps1"]);
  assert.deepEqual(launcherArgv(["/usr/local/bin/claude-deepseek"], "claude"), ["/usr/local/bin/claude-deepseek"]);
  assert.equal(launcherArgv(["claude"], "claude"), null);
  assert.equal(launcherArgv(deepseek, "codex"), null);
  assert.equal(launcherArgv([], "claude"), null);
  assert.equal(launcherArgv(["claude-deepseek", "--resume", id], "claude"), null);
  assert.equal(launcherArgv(["claude-deepseek", "--session-id=" + id], "claude"), null);
  assert.equal(launcherArgv(["claude-deepseek", "x".repeat(261)], "claude"), null);
  assert.equal(commandLine(record({ agent: "claude", launcher: deepseek }), "powershell"), `& '${deepseek[0]}' '--resume' '${id}'`);
  assert.equal(commandLine(record({ agent: "claude", launcher: ["not-a-launcher"] }), "powershell"), `& 'claude' '--resume' '${id}'`);
  const home = mkdtempSync(join(tmpdir(), "herdr-launcher-read-")), run = join(home, "run");
  mkdirSync(run); writeFileSync(join(run, "control.json"), "{}");
  writeFileSync(join(run, "task.json"), JSON.stringify({ agent: "claude", native: true, argv: deepseek }));
  writeFileSync(join(run, "state.json"), JSON.stringify({ native: true, running: false }));
  assert.deepEqual(runLauncher(join(run, "control.json"), "claude"), deepseek, "an observer that stopped with its terminal still names the launcher");
  writeFileSync(join(run, "state.json"), JSON.stringify({ native: false, running: true }));
  assert.equal(runLauncher(join(run, "control.json"), "claude"), null);
  writeFileSync(join(run, "state.json"), JSON.stringify({ native: true, running: true }));
  writeFileSync(join(run, "task.json"), JSON.stringify({ agent: "claude", native: true, argv: ["claude"] }));
  assert.equal(runLauncher(join(run, "control.json"), "claude"), null);
  assert.equal(runLauncher(join(home, "missing/control.json"), "claude"), null);
  assert.equal(runLauncher(null, "claude"), null);
});
test("recovery resumes through the launcher that started the session and keeps it for retries", async () => {
  const home = mkdtempSync(join(tmpdir(), "herdr-launcher-")), run = join(home, "run"), transcript = join(home, "thread.jsonl");
  mkdirSync(run);
  writeFileSync(join(run, "control.json"), JSON.stringify({ enabled: true, exceptions: [] }));
  writeFileSync(join(run, "state.json"), JSON.stringify({ native: true, running: true }));
  writeFileSync(join(run, "task.json"), JSON.stringify({ agent: "claude", cwd: home, native: true, argv: ["C:\\Tools\\claude-deepseek.cmd"] }));
  writeFileSync(transcript, JSON.stringify({ sessionId: id, type: "user", isSidechain: false }));
  const t = term({ labels: { "herdr.space": "s1", "herdr.unattended.control": join(run, "control.json") } });
  const c = new FakeCore(t, record({ agent: "claude", executable: "C:\\Tools\\claude.exe", transcript, unattended: true, unattendedControl: join(run, "control.json") }));
  await new Recovery(c, home).tick();
  const send = c.calls.filter(c => c.method === "terminal.send");
  assert.equal(send.length, 1);
  assert.equal(send[0].params.text, `& 'C:\\Tools\\claude-deepseek.cmd' '--resume' '${id}'`);
  assert.deepEqual(c.doc.records["t1:1"].launcher, ["C:\\Tools\\claude-deepseek.cmd"]);
});
test("a recovered approval observer records the launcher it resumed through", async () => {
  const home = mkdtempSync(join(tmpdir(), "herdr-observer-launcher-")), run = join(home, "run"), control = join(run, "control.json");
  mkdirSync(run);
  writeFileSync(control, JSON.stringify({ enabled: true, exceptions: ["git push"] }));
  writeFileSync(join(run, "state.json"), JSON.stringify({ native: true, running: true }));
  writeFileSync(join(run, "task.json"), JSON.stringify({ agent: "claude", native: true, argv: ["claude-official"] }));
  const t = term({ status: { app: "claude" }, labels: { "herdr.space": "s1", "herdr.unattended.control": control } });
  const c = new FakeCore(t, record({ agent: "claude", pid: 20, generation: "new", unattended: true, unattendedControl: control, attempt: { pid: 20, generation: "new" } }));
  await new Recovery(c, home).tick();
  const observed = c.calls.find(c => c.method === "terminal.run");
  const config = JSON.parse(readFileSync(observed.params.argv.at(-1), "utf8"));
  assert.deepEqual(config.argv, ["claude-official"]);
  assert.deepEqual(config.exceptions, ["git push"]);
});
test("root transcript and process ancestry exclude spawned agents and preserve forks", () => {
  const payload = { session_id: id, transcript_path: "/test" };
  const read = source => JSON.stringify({ type: "session_meta", payload: { id, source, thread_source: "user" } });
  assert(rootTranscript("codex", payload, () => read("cli")));
  assert(!rootTranscript("codex", payload, () => read({ subagent: "spawn" })));
  assert(rootTranscript("antigravity", { conversationId: id, transcriptPath: "/test" }, () => JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT" })));
  assert(!rootTranscript("antigravity", { conversationId: id, transcriptPath: "/test" }, () => JSON.stringify({ step_index: 0, source: "SYSTEM", type: "SYSTEM_MESSAGE" })));
  const rows = [{ pid: 1, parent: 0, name: "powershell.exe" }, { pid: 2, parent: 1, name: "codex.exe" }, { pid: 3, parent: 2, name: "node.exe" }];
  assert(rootProcess(1, 3, rows, "codex"));
  assert(!rootProcess(1, 5, [...rows, { pid: 4, parent: 3, name: "codex.exe" }, { pid: 5, parent: 4, name: "node.exe" }], "codex"));
  const agyRows = [{ pid: 1, parent: 0, name: "powershell.exe" }, { pid: 2, parent: 1, name: "agy.exe" }, { pid: 3, parent: 2, name: "node.exe" }];
  assert(rootProcess(1, 3, agyRows, "antigravity"));
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
  const result = install(home, { CODEX_HOME: root, CLAUDE_CONFIG_DIR: join(home, "absent"), ANTIGRAVITY_CONFIG_DIR: join(home, "absent-agy") });
  assert.equal(result[0].state, "error");
  assert.equal(readFileSync(join(root, "hooks.json"), "utf8"), "broken-json");
  const agyMerged = mergeAntigravityHooks({
    linter: { PostToolUse: [{ matcher: "run_command", hooks: [{ command: "lint" }] }] },
    "herdr-recovery": { PreToolUse: [{ matcher: "*", hooks: [{ command: "old" }] }] },
  }, command);
  assert.equal(agyMerged.linter.PostToolUse[0].matcher, "run_command");
  assert.equal(agyMerged["herdr-recovery"].PreToolUse, undefined);
  assert.equal(agyMerged["herdr-recovery"].SessionStart[0].command, command);
  assert.deepEqual(mergeAntigravityHooks(agyMerged, command), agyMerged);
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
  const agyRows = [{ pid: 20, parent: 0, name: "powershell.exe" }, { pid: 22, parent: 20, name: "agy.exe", command: `"D:\\Tools\\AntigravityCLI\\bin\\agy.exe" --conversation ${id}` }];
  assert.equal(resumedProcess(term(), record({ agent: "antigravity" }), agyRows).pid, 22);
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
  const root = mkdtempSync(join(tmpdir(), "herdr-hook-path-")), home = join(root, "app's 中文"), codex = join(root, "codex's 中文"), agyCfg = join(root, "agy's 中文");
  mkdirSync(join(home, "mods/recovery"), { recursive: true }); mkdirSync(codex); mkdirSync(agyCfg);
  const result = install(home, { CODEX_HOME: codex, CLAUDE_CONFIG_DIR: join(root, "missing"), ANTIGRAVITY_CONFIG_DIR: agyCfg });
  assert.equal(result[0].state, "installed");
  assert.equal(result[2].state, "installed");
  const args = process.platform === "win32" ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(codex, "herdr-recovery-hook.ps1")] : [join(codex, "herdr-recovery-hook.sh")];
  const env = { ...process.env }; delete env.HC_TERMINAL_ID;
  // The provider-owned helper still loads after the app's temporary home is gone.
  rmSync(home, { recursive: true });
  const run = spawnSync(process.platform === "win32" ? "powershell.exe" : "sh", args, { env, encoding: "utf8", windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "");
  assert(existsSync(join(result[0].runtime, "hook.mjs")));
  // Antigravity hooks always emit valid JSON responses (including Stop decision) on stdout.
  const agyArgs = process.platform === "win32" ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(agyCfg, "herdr-recovery-hook.ps1")] : [join(agyCfg, "herdr-recovery-hook.sh")];
  const stopRun = spawnSync(process.platform === "win32" ? "powershell.exe" : "sh", agyArgs, {
    env, input: JSON.stringify({ conversationId: id, hookEventName: "Stop" }), encoding: "utf8", windowsHide: true,
  });
  assert.equal(stopRun.status, 0, stopRun.stderr);
  assert.deepEqual(JSON.parse(stopRun.stdout), { decision: "allow" });
  const preToolRun = spawnSync(process.platform === "win32" ? "powershell.exe" : "sh", agyArgs, {
    env, input: JSON.stringify({ conversationId: id, hookEventName: "PreToolUse", toolCall: { name: "read_file", args: {} } }), encoding: "utf8", windowsHide: true,
  });
  assert.equal(preToolRun.status, 0, preToolRun.stderr);
  assert.deepEqual(JSON.parse(preToolRun.stdout), { decision: "ask" });
  const cliBrain = join(root, ".gemini/antigravity-cli/brain", id, ".system_generated/logs");
  mkdirSync(cliBrain, { recursive: true });
  const realTranscript = join(cliBrain, "transcript.jsonl");
  writeFileSync(realTranscript, JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT" }));
  assert.equal(resolveAntigravityTranscript(id, join(root, ".gemini/antigravity/brain", id, ".system_generated/logs/transcript.jsonl"), root, {}), realTranscript);
});

test("preview startup cannot replace either daily provider's hook, even with inherited default roots", t => {
  const user = mkdtempSync(join(tmpdir(), "herdr-isolation-"));
  t.after(() => rmSync(user, { recursive: true, force: true }));
  const home = join(user, ".config/herdr-app"), preview = join(user, "preview");
  const roots = { codex: join(user, ".codex"), claude: join(user, ".claude"), antigravity: join(user, ".gemini/config") };
  for (const root of Object.values(roots)) mkdirSync(root, { recursive: true });
  const installed = install(home, {}, process.platform, user);
  const names = agent => [join(roots[agent], agent === "claude" ? "settings.json" : "hooks.json"), join(roots[agent], process.platform === "win32" ? "herdr-recovery-hook.ps1" : "herdr-recovery-hook.sh")];
  const before = Object.keys(roots).flatMap(names).map(p => [p, readFileSync(p, "utf8"), statSync(p).mtimeMs]);
  for (const env of [{}, { CODEX_HOME: roots.codex, CLAUDE_CONFIG_DIR: roots.claude, ANTIGRAVITY_CONFIG_DIR: roots.antigravity }, { HC_SESSION: "preview" }]) {
    assert(install(preview, env, process.platform, user).every(r => r.state === "isolated"));
  }
  assert(install(home, { HC_SESSION: "preview" }, process.platform, user).every(r => r.state === "isolated"));
  install(home, {}, process.platform, user);
  for (const [p, text, mtime] of before) { assert.equal(readFileSync(p, "utf8"), text); assert.equal(statSync(p).mtimeMs, mtime); }
  for (const row of installed) assert(row.runtime.startsWith(roots[row.agent]));
  const own = join(preview, "codex"), ownAgy = join(preview, "agy-cfg");
  mkdirSync(own, { recursive: true }); mkdirSync(ownAgy, { recursive: true });
  const previewRes = install(preview, { CODEX_HOME: own, ANTIGRAVITY_CONFIG_DIR: ownAgy, HC_SESSION: "preview" }, process.platform, user);
  assert.equal(previewRes[0].state, "installed");
  assert.equal(previewRes[2].state, "installed");
});

test("an overwritten launcher is repaired without changing hook trust identity or foreign hooks", t => {
  const user = mkdtempSync(join(tmpdir(), "herdr-repair-"));
  t.after(() => rmSync(user, { recursive: true, force: true }));
  const home = join(user, ".config/herdr-app"), root = join(user, ".codex"); mkdirSync(root, { recursive: true });
  const hookPath = join(root, "hooks.json");
  writeFileSync(hookPath, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "foreign-hook" }] }] } }));
  install(home, {}, process.platform, user);
  const config = readFileSync(hookPath, "utf8"), mtime = statSync(hookPath).mtimeMs;
  const launcher = join(root, process.platform === "win32" ? "herdr-recovery-hook.ps1" : "herdr-recovery-hook.sh");
  const correct = readFileSync(launcher, "utf8");
  writeFileSync(launcher, "old preview launcher pointing at a deleted directory");
  install(home, {}, process.platform, user);
  assert.equal(readFileSync(launcher, "utf8"), correct);
  assert.equal(readFileSync(hookPath, "utf8"), config);
  assert.equal(statSync(hookPath).mtimeMs, mtime);
});

test("uncaptured agents remain visible after loss, never receive guessed input, and clear on exact capture", async t => {
  const home = mkdtempSync(join(tmpdir(), "herdr-uncaptured-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const c = new FakeCore(term({ status: { app: "codex" } })); c.doc.records = {};
  const recovery = new Recovery(c, home);
  assert.equal((await recovery.tick()).records[0].state, "uncaptured");
  c.term = term();
  assert.equal((await recovery.tick()).records[0].state, "uncaptured");
  assert(!c.calls.some(c => c.method === "terminal.send"));
  const transcript = join(home, "thread.jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: { id, source: "cli" } }));
  await capture(c, "codex", { session_id: id, transcript_path: transcript, hook_event_name: "SessionStart" }, "t1", async () => true);
  assert.equal(c.doc.uncaptured["t1:1"], undefined);
  assert.equal((await recovery.tick()).records[0].sessionId, id);
});

test("a concurrent capture wins over a prepared missing-identity diagnostic", async t => {
  const home = mkdtempSync(join(tmpdir(), "herdr-diagnostic-race-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const c = new FakeCore(term({ status: { app: "codex" } })); c.doc.records = {};
  const update = c.update.bind(c);
  c.update = async (name, change) => { c.doc.records["t1:1"] = record(); return update(name, change); };
  const result = await new Recovery(c, home).tick();
  assert.deepEqual(c.doc.uncaptured, {});
  assert.equal(result.records[0].sessionId, id);
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

test("Antigravity tool decisions follow the live terminal and current exception policy", async t => {
  const { antigravityDecision } = await import("../defaults/mods/recovery/hook.mjs");
  const directory = mkdtempSync(join(tmpdir(), "herdr-agy-decision-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const control = join(directory, "control.json");
  const terminal = term({ labels: { "herdr.unattended": "on", "herdr.unattended.control": control } });
  const core = { call: async () => terminal };
  const state = { agent: "antigravity", native: true, ready: true, running: true, terminal: terminal.address,
    sourceCreated: terminal.created_ms, sourcePid: terminal.pid, agentPid: 42, updated: Date.now(), pid: process.pid };
  const save = (file, value) => writeFileSync(join(directory, file), JSON.stringify(value));
  const decide = (name, args, pid = 42) => antigravityDecision(core, { conversationId: id, toolCall: { name, args } },
    terminal.address, async () => ({ pid }));
  save("state.json", state);
  save("control.json", { enabled: true, exceptions: ["Git Push"] });
  assert.deepEqual(await decide("run_command", { CommandLine: "npm test" }), { decision: "allow" });
  assert.deepEqual(await decide("run_command", { CommandLine: "git push" }), { decision: "force_ask" });
  assert.deepEqual(await decide("ask_question", {}), { decision: "ask" });
  assert.deepEqual(await decide("run_command", {}, 43), { decision: "ask" });
  save("state.json", { ...state, updated: Date.now() - 60000 });
  assert.deepEqual(await decide("run_command", {}), { decision: "ask" });
  save("state.json", state);
  save("control.json", { enabled: false, exceptions: [] });
  assert.deepEqual(await decide("run_command", {}), { decision: "ask" });
  assert.equal(JSON.parse(readFileSync(join(directory, "events.jsonl"), "utf8")).tool, "run_command");
});
