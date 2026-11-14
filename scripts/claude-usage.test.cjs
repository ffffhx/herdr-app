const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const bridge = require("../defaults/mods/workspace-status/claude-usage.cjs");
const { readClaude } = require("../defaults/mods/workspace-status/quota-probe.cjs");
const script = path.resolve(__dirname, "../defaults/mods/workspace-status/claude-usage.cjs");
const id = "11111111-2222-4333-8444-555555555555";
const now = 1800000000000;
const payload = { session_id: id, rate_limits: { five_hour: { used_percentage: 25, resets_at: now / 1000 + 3600 } } };
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "herdr usage's "));
  const term = { address: "t1", pid: 1234, created_ms: 120000, state: "live" };
  const calls = [], options = { home, term, env: { HC_TERMINAL_ID: "t1" }, core: args => { calls.push(args); return {}; } };
  return { home, term, calls, options, close: () => {
    assert.equal(path.dirname(path.resolve(home)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith("herdr usage's "));
    fs.rmSync(home, { recursive: true, force: true });
  } };
}
test("statusLine whitelists only session ID and valid subscription windows", () => {
  const usage = bridge.normalize({ ...payload, transcript: "SECRET", auth: "SECRET", rate_limits: { ...payload.rate_limits, seven_day: { used_percentage: 0, resets_at: now / 1000 + 86400 } } }, now);
  assert.deepEqual(usage.windows.map(w => w.remaining), [75, 100]);
  assert.doesNotMatch(JSON.stringify(usage), /SECRET/);
  for (const used of [null, "0", NaN, Infinity, -1, 101]) assert.deepEqual(bridge.normalize({ ...payload, rate_limits: { five_hour: { used_percentage: used, resets_at: now / 1000 + 100 } } }, now).windows, []);
  assert.deepEqual(bridge.normalize({ session_id: id }, now).windows, []);
  assert.equal(bridge.normalize({ session_id: "../../escape" }, now), null);
  assert.deepEqual(bridge.normalize(payload, now + 3600000).windows, []);
});
test("new, resumed and replaced sessions cannot borrow another session's usage", () => {
  const f = fixture();
  try {
    const first = bridge.register("official", f.options);
    assert.equal(bridge.readUsage(f.home, f.term, now).status, "waiting");
    bridge.capture(first.descriptor, payload, now);
    assert.equal(bridge.readUsage(f.home, f.term, now).windows[0].remaining, 75);
    assert.equal(bridge.readUsage(f.home, { ...f.term, created_ms: 120001 }, now).status, "provider-unknown");
    const second = bridge.register("official", f.options);
    bridge.capture(first.descriptor, payload, now); // Old launch has its own file.
    assert.equal(bridge.readUsage(f.home, f.term, now).status, "waiting");
    bridge.end(first.descriptor);
    assert.equal(bridge.readUsage(f.home, f.term, now).status, "waiting");
    bridge.capture(second.descriptor, { ...payload, session_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }, now);
    assert.equal(bridge.readUsage(f.home, f.term, now).status, "ok");
    bridge.capture(second.descriptor, { session_id: id }, now + 1);
    assert.equal(bridge.readUsage(f.home, f.term, now + 1).status, "waiting");
    bridge.end(second.descriptor);
    assert.equal(bridge.readUsage(f.home, f.term, now).status, "provider-unknown");
  } finally { f.close(); }
});
test("expired windows and stale snapshots do not imply a refreshed full quota", () => {
  const f = fixture();
  try {
    const registration = bridge.register("official", f.options);
    bridge.capture(registration.descriptor, payload, now);
    assert.equal(bridge.readUsage(f.home, f.term, now + 3600000).status, "waiting");
    assert.equal(bridge.readUsage(f.home, f.term, now + bridge.TTL + 1).status, "stale");
  } finally { f.close(); }
});
test("official and unknown sessions never fetch or read login credentials on any platform", async () => {
  const f = fixture();
  try {
    const original = fs.promises.readFile;
    fs.promises.readFile = async () => assert.fail("must not read account settings or credentials");
    try {
      for (const platform of ["win32", "darwin"]) {
        assert.equal((await readClaude({ home: f.home, platform, env: {}, target: f.term, request: () => assert.fail("network") })).status, "provider-unknown");
        bridge.register("official", f.options);
        assert.equal((await readClaude({ home: f.home, platform, env: {}, appDirectory: f.home, target: f.term, request: () => assert.fail("network") })).status, "waiting");
      }
    } finally { fs.promises.readFile = original; }
  } finally { f.close(); }
});
test("DeepSeek uses the explicit launcher's settings, not inherited official credentials", async () => {
  const f = fixture();
  try {
    const settingsFile = path.join(f.home, "deepseek.json");
    fs.writeFileSync(settingsFile, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_AUTH_TOKEN: "test-deepseek" } }));
    bridge.register("deepseek", { ...f.options, settingsFile });
    const result = await readClaude({ target: f.term, appDirectory: f.home, env: { ANTHROPIC_AUTH_TOKEN: "official-secret" }, request: async (url, options) => {
      assert.equal(url, "https://api.deepseek.com/user/balance");
      assert.equal(options.headers.Authorization, "Bearer test-deepseek");
      return { ok: true, json: async () => ({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "22.17" }] }) };
    } });
    assert.equal(result.balances[0].total, "22.17");
    assert.doesNotMatch(JSON.stringify(result), /secret|test-deepseek|settingsFile/);
  } finally { f.close(); }
});
test("existing native sessions use launch argv, never tab names or unbound task files", () => {
  const f = fixture();
  try {
    const directory = path.join(f.home, "data/unattended/runs/test");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "task.json"), JSON.stringify({ native: true, agent: "claude", argv: ["claude-official"] }));
    fs.writeFileSync(path.join(directory, "state.json"), JSON.stringify({ native: true, running: true, sourceTerminal: "t1", sourceCreated: f.term.created_ms }));
    f.term.labels = { "herdr.unattended.control": path.join(directory, "control.json") };
    assert.equal(bridge.readUsage(f.home, f.term).provider, "claude-official");
    assert.equal(bridge.readUsage(f.home, { ...f.term, address: "t2", name: "Claude-Official" }).status, "provider-unknown");
    assert.equal(bridge.nativeProvider(f.home, { ...f.term, labels: {}, name: "Claude-Official" }), null);
  } finally { f.close(); }
});
test("statusLine wrapper preserves the original command's stdin and stdout without network", () => {
  const f = fixture();
  try {
    const echo = path.join(f.home, "echo.cjs");
    fs.writeFileSync(echo, "process.stdin.resume();process.stdin.on('data',b=>process.stdout.write(JSON.parse(b).session_id))");
    const command = bridge.commandLine([process.execPath, echo]);
    const registration = bridge.register("official", { ...f.options, previous: { type: "command", command, padding: 2 } });
    assert.equal(registration.statusLine.padding, 2);
    const result = spawnSync(process.execPath, [script, "capture", registration.descriptor], { input: JSON.stringify(payload), encoding: "utf8", windowsHide: true, timeout: 5000 });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, id);
    assert.equal(bridge.readUsage(f.home, f.term).provider, "claude-official");
    assert.match(bridge.commandLine(["/tmp/it's a path"], "darwin"), /'\\''/);
    assert.throws(() => bridge.commandLine(["C:/$(unsafe)/node.exe"], "win32"));
  } finally { f.close(); }
});

test("personal copies localize on older hosts without changing the selected language", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../defaults/mods/workspace-status/usage-text.js"), "utf8")
    .replace(/^import .*;\r?\n/gm, "").replace(/export /g, "");
  const factory = new Function("tr", source + ";return usageText;");
  assert.equal(factory(s => s)("Claude Official"), "Claude Official");
  assert.equal(factory(s => s === "Weekly" ? "每周" : s)("Claude Official"), "Claude 官方");
  assert.equal(factory(s => s === "Claude Official" ? "new translation" : s)("Claude Official"), "new translation");
});

test("the mod's actual probe argv reads a bound local snapshot without Claude", () => {
  const f = fixture();
  try {
    const registration = bridge.register("official", f.options);
    bridge.capture(registration.descriptor, payload);
    const result = spawnSync(process.execPath, [path.join(path.dirname(script), "quota-probe.cjs"), "claude", JSON.stringify(f.term), f.home],
      { encoding: "utf8", windowsHide: true, timeout: 5000 });
    assert.equal(result.status, 0);
    const value = JSON.parse(result.stdout);
    assert.equal(value.provider, "claude-official");
    assert.equal(value.windows[0].remaining, 75);
    assert.doesNotMatch(result.stdout, /descriptor|launchId|sessionId|settingsFile/);
  } finally { f.close(); }
});
