const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const bridge = require("../defaults/mods/workspace-status/antigravity-usage.cjs");
const { readAntigravity } = require("../defaults/mods/workspace-status/quota-probe.cjs");

const now = 1800000000000;
const samplePayload = {
  product: "antigravity",
  email: "SECRET@example.com",
  transcript_path: "C:\\SECRET\\transcript.jsonl",
  model: { id: "Gemini 4 Carbon (High)", display_name: "Gemini 4 Carbon (High)" },
  quota: {
    "3p-5h": { remaining_fraction: 1, reset_time: new Date(now + 18000000).toISOString(), reset_in_seconds: 18000 },
    "3p-weekly": { remaining_fraction: 0.4, reset_time: new Date(now + 604800000).toISOString(), reset_in_seconds: 604800 },
    "gemini-5h": { remaining_fraction: 0.85, reset_time: new Date(now + 15000000).toISOString(), reset_in_seconds: 15000 },
    "gemini-weekly": { remaining_fraction: 0.95, reset_time: new Date(now + 600000000).toISOString(), reset_in_seconds: 600000 },
  },
};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "herdr agy's "));
  const userHome = path.join(root, "user");
  const appDir = path.join(userHome, ".config", "herdr-app");
  const agyDir = path.join(userHome, ".gemini", "antigravity-cli");
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(agyDir, { recursive: true });
  const term = { address: "t4", pid: 2468, created_ms: 500000, state: "live" };
  return {
    root, userHome, appDir, agyDir, term,
    close: () => {
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith("herdr agy's "));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("normalize selects active Gemini or 3P pool, orders windows, and strips account fields", () => {
  const gemini = bridge.normalize(samplePayload, now);
  assert.equal(gemini.pool, "gemini");
  assert.deepEqual(gemini.windows.map(w => [w.minutes, Math.round(w.remaining)]), [[300, 85], [10080, 95]]);
  assert.doesNotMatch(JSON.stringify(gemini), /SECRET|email|transcript/i);

  const claudeModel = bridge.normalize({
    ...samplePayload,
    model: { id: "claude-opus-4-6-thinking", display_name: "Claude Opus 4.6 (Thinking)" },
  }, now);
  assert.equal(claudeModel.pool, "3p");
  assert.deepEqual(claudeModel.windows.map(w => [w.minutes, Math.round(w.remaining)]), [[300, 100], [10080, 40]]);

  for (const bad of [null, -0.01, 1.01, "0.5", NaN, Infinity]) {
    const out = bridge.normalize({
      product: "antigravity",
      quota: { "gemini-5h": { remaining_fraction: bad, reset_time: new Date(now + 60000).toISOString() } },
    }, now);
    assert.deepEqual(out.windows, []);
  }
  const disabled = bridge.normalize({
    product: "antigravity",
    quota: { "gemini-5h": { remaining_fraction: 0.9, disabled: true, reset_time: new Date(now + 60000).toISOString() } },
  }, now);
  assert.deepEqual(disabled.windows, []);
  assert.equal(bridge.normalize({ product: "other", quota: samplePayload.quota }, now), null);
});

test("installStatusLine is idempotent, handles spaces/apostrophes, and preserves previous statusLine", () => {
  const f = fixture();
  try {
    const prevScript = path.join(f.root, "prev.cjs");
    fs.writeFileSync(prevScript, 'process.stdout.write("CUSTOM_STATUS");');
    fs.writeFileSync(path.join(f.agyDir, "settings.json"), JSON.stringify({
      agentMode: "accept-edits",
      statusLine: { type: "command", command: `"${process.execPath}" "${prevScript}"` },
    }));
    const first = bridge.installStatusLine({ home: f.appDir, userHome: f.userHome, env: { PATH: path.dirname(process.execPath) } });
    assert.equal(first.state, "installed");
    assert.ok(bridge.isManagedCommand(first.command));
    assert.ok(!/\s/.test(first.command.trim().split(/\s+/).slice(2).join("")), "arguments after -e must be whitespace-free when paths contain spaces");
    const mtime1 = fs.statSync(first.path).mtimeMs;

    const second = bridge.installStatusLine({ home: f.appDir, userHome: f.userHome, env: { PATH: path.dirname(process.execPath) } });
    assert.equal(second.state, "installed");
    assert.equal(fs.statSync(second.path).mtimeMs, mtime1, "idempotent install must not rewrite settings.json");
    const savedConfig = JSON.parse(fs.readFileSync(first.configPath, "utf8"));
    assert.match(savedConfig.previous.command, /prev\.cjs/);

    // Verify whitespace-split execution (exact Antigravity StatusLineRunner semantics) preserves previous stdout.
    const fields = first.command.trim().split(/\s+/);
    const bin = fields[0] === "node" ? process.execPath : fields[0];
    const run = spawnSync(bin, fields.slice(1), {
      input: JSON.stringify(samplePayload),
      env: { ...process.env, HC_TERMINAL_ID: "" },
      encoding: "utf8",
    });
    assert.equal(run.status, 0);
    assert.equal(run.stdout, "CUSTOM_STATUS");
  } finally { f.close(); }
});

test("isolated Herdr instances never modify the shared default Antigravity settings.json", () => {
  const f = fixture();
  try {
    const isolatedHome = path.join(f.root, "preview-home");
    fs.mkdirSync(isolatedHome, { recursive: true });
    assert.equal(bridge.installStatusLine({ home: isolatedHome, userHome: f.userHome, env: {} }).state, "isolated");
    assert.equal(fs.existsSync(path.join(f.agyDir, "settings.json")), false);

    assert.equal(bridge.installStatusLine({ home: f.appDir, userHome: f.userHome, env: { HC_SESSION: "preview-core" } }).state, "isolated");
    assert.equal(fs.existsSync(path.join(f.agyDir, "settings.json")), false);

    const isolatedAgy = path.join(f.root, "preview-agy");
    fs.mkdirSync(isolatedAgy, { recursive: true });
    const allowed = bridge.installStatusLine({
      home: isolatedHome, userHome: f.userHome,
      env: { HC_SESSION: "preview-core", ANTIGRAVITY_CLI_HOME: isolatedAgy, PATH: path.dirname(process.execPath) },
    });
    assert.equal(allowed.state, "installed");
    const written = JSON.parse(fs.readFileSync(path.join(isolatedAgy, "settings.json"), "utf8"));
    assert.equal(written.statusLine.stack_with_default, true);
  } finally { f.close(); }
});

test("capture binds terminal identity, respects session boundaries, and expires cleanly", async () => {
  const f = fixture();
  try {
    const env = { HC_TERMINAL_ID: "t4", HERDR_APP_HOME: f.appDir };
    assert.equal(bridge.readUsage(f.appDir, f.term, now).status, "waiting");
    assert.equal(bridge.capture(samplePayload, { env, userHome: f.userHome, now, core: () => f.term }), true);

    const ok = bridge.readUsage(f.appDir, f.term, now);
    assert.equal(ok.status, "ok");
    assert.equal(ok.pool, "gemini");
    assert.equal(Math.floor(ok.windows[0].remaining), 85);

    // Different PID or created_ms cannot inherit the previous terminal's usage.
    assert.equal(bridge.readUsage(f.appDir, { ...f.term, created_ms: f.term.created_ms + 1 }, now).status, "waiting");
    // Expired window and TTL transitions.
    assert.equal(bridge.readUsage(f.appDir, f.term, now + 601000000).status, "stale");
    assert.equal(bridge.readUsage(f.appDir, f.term, now + bridge.TTL + 1).status, "stale");

    // Non-Herdr terminals and isolated HC_SESSION without HERDR_APP_HOME never write into daily home.
    assert.equal(bridge.capture(samplePayload, { env: {}, userHome: f.userHome, now, core: () => assert.fail("no hc outside terminal") }), false);
    assert.equal(bridge.capture(samplePayload, { env: { HC_TERMINAL_ID: "t4", HC_SESSION: "isolated" }, userHome: f.userHome, now, core: () => assert.fail("isolated") }), false);

    // Probe reads local snapshot on both Windows and macOS without network access.
    for (const platform of ["win32", "darwin"]) {
      const probed = await readAntigravity({
        home: f.userHome, platform, appDirectory: f.appDir, target: f.term,
        env: { ANTIGRAVITY_CLI_HOME: f.agyDir, PATH: path.dirname(process.execPath) },
      });
      assert.equal(probed.provider, "antigravity");
      assert.ok(["ok", "waiting", "stale"].includes(probed.status));
    }
  } finally { f.close(); }
});
