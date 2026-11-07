const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { windowUsage, codexUsage, claudeUsage, deepseekBalance, claudeApi, readDeepseek, codexCommand, readCodex, readClaude } = require("../defaults/mods/workspace-status/quota-probe.cjs");

const deepseekReply = { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "25.42", granted_balance: "0.00", topped_up_balance: "25.42" }] };

test("DeepSeek reports money, including zero/negative balances, without inventing percentage quotas", () => {
  const result = deepseekBalance(deepseekReply);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.balances, [{ currency: "CNY", total: "25.42", granted: "0.00", toppedUp: "25.42" }]);
  assert.deepEqual(result.windows, []);
  for (const total of ["0.00", "-0.01"]) {
    const empty = deepseekBalance({ is_available: false, balance_infos: [{ currency: "USD", total_balance: total }] });
    assert.equal(empty.status, "ok");
    assert.equal(empty.available, false);
    assert.equal(empty.balances[0].total, total);
  }
  for (const total of [null, "", "NaN", "Infinity", 12, "SECRET", "0x10"]) {
    assert.equal(deepseekBalance({ balance_infos: [{ currency: "CNY", total_balance: total }] }).status, "unavailable");
  }
  assert.equal(deepseekBalance({ balance_infos: {} }).status, "unavailable");
});

test("API routing recognizes the official DeepSeek service, never a model name or lookalike host", () => {
  for (const suffix of ["", "/", "/anthropic", "/anthropic/", "/v1"]) {
    assert.deepEqual(claudeApi({ ANTHROPIC_BASE_URL: "https://api.deepseek.com" + suffix, ANTHROPIC_AUTH_TOKEN: "test-key" }), { provider: "deepseek", token: "test-key" });
  }
  for (const url of ["https://api.deepseek.com.evil.test/anthropic", "http://api.deepseek.com/anthropic", "https://api.deepseek.com:444/anthropic", "https://user@api.deepseek.com", "http://localhost:8080", "invalid"]) {
    assert.equal(claudeApi({ ANTHROPIC_BASE_URL: url, ANTHROPIC_AUTH_TOKEN: "test-key" }).provider, "unsupported");
  }
  assert.equal(claudeApi({ ANTHROPIC_MODEL: "deepseek-flash" }).provider, "claude");
  assert.equal(claudeApi({ ANTHROPIC_API_KEY: "test-key" }).provider, "unsupported");
});

test("DeepSeek uses the balance GET endpoint and keeps raw diagnostics and credentials out of its output", async () => {
  const result = await readDeepseek("SECRET", async (url, options) => {
    assert.equal(url, "https://api.deepseek.com/user/balance");
    assert.equal(options.headers.Authorization, "Bearer SECRET");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    return { ok: true, json: async () => ({ ...deepseekReply, diagnostic: "SECRET" }) };
  });
  assert.equal(result.balances[0].total, "25.42");
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  for (const [code, status] of [[401, "api-key-invalid"], [403, "api-key-invalid"], [429, "rate-limited"], [500, "unavailable"]]) {
    const failed = await readDeepseek("SECRET", async () => ({ ok: false, status: code }));
    assert.deepEqual(failed, { provider: "deepseek", status, windows: [] });
  }
  const timeout = await readDeepseek("SECRET", async () => { const error = new Error("SECRET"); error.name = "TimeoutError"; throw error; });
  assert.equal(timeout.status, "timeout");
  assert.doesNotMatch(JSON.stringify(timeout), /SECRET/);
  assert.equal((await readDeepseek("", () => assert.fail("missing keys must not send a request"))).status, "api-key-missing");
});

test("Claude loads global DeepSeek settings before OAuth on Windows and macOS, including custom config directories", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-balance-"));
  try {
    for (const platform of ["win32", "darwin"]) {
      for (const custom of [false, true]) {
        const directory = path.join(home, custom ? "custom" : ".claude");
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_AUTH_TOKEN: "settings-key" } }));
        fs.writeFileSync(path.join(directory, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "unrelated-oauth-key" } }));
        const result = await readClaude({ home, platform, env: { ...(custom ? { CLAUDE_CONFIG_DIR: directory } : {}), ANTHROPIC_BASE_URL: "https://api.anthropic.com" }, request: async (url, options) => {
          assert.equal(url, "https://api.deepseek.com/user/balance");
          assert.equal(options.headers.Authorization, "Bearer settings-key");
          return { ok: true, json: async () => deepseekReply };
        } });
        assert.equal(result.provider, "deepseek");
      }
    }
    fs.writeFileSync(path.join(home, ".claude/settings.json"), "{}");
    const oauth = await readClaude({ home, env: {}, platform: "win32", request: async (url, options) => {
      assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
      assert.equal(options.headers.Authorization, "Bearer unrelated-oauth-key");
      return { ok: true, json: async () => ({ five_hour: { utilization: 20 } }) };
    } });
    assert.equal(oauth.windows[0].remaining, 80);
    const unknown = await readClaude({ home, env: { ANTHROPIC_BASE_URL: "https://gateway.example" }, request: () => assert.fail("must not query unrelated OAuth credentials") });
    assert.equal(unknown.status, "api-unsupported");
    fs.writeFileSync(path.join(home, ".claude/settings.json"), "invalid settings SECRET");
    await assert.rejects(readClaude({ home, env: {} }), /^Error: unavailable$/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("remaining percentages are bounded; missing values are unknown, including null", () => {
  for (const value of [null, {}, { usedPercent: null }, { usedPercent: "25" }, { usedPercent: NaN }]) assert.equal(windowUsage(value, 300), null);
  assert.equal(windowUsage({ usedPercent: 0 }, 300).remaining, 100);
  assert.equal(windowUsage({ usedPercent: 120 }, 300).remaining, 0);
  assert.equal(windowUsage({ usedPercent: -5 }, 300).remaining, 100);
  assert.equal(windowUsage({ usedPercent: 80, resetsAt: 123 }, 300).resetsAt, 123000);
});

test("actual window lengths and general Codex bucket take priority", () => {
  const value = codexUsage({ rateLimits: { primary: { usedPercent: 9 } }, rateLimitsByLimitId: { codex: { primary: { usedPercent: 45, windowDurationMins: 10080 }, secondary: null } } });
  assert.deepEqual(value.windows.map(w => [w.remaining, w.minutes]), [[55, 10080]]);
  assert.equal(codexUsage({}).status, "unavailable");
  assert.equal(claudeUsage({ five_hour: { utilization: 22 }, seven_day: { utilization: 91 } }).windows[1].remaining, 9);
});

test("Windows npm paths with spaces and apostrophes do not need a shell", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr quota's "));
  try {
    fs.mkdirSync(path.join(dir, "node_modules/@openai/codex/bin"), { recursive: true });
    fs.writeFileSync(path.join(dir, "codex.cmd"), "unused");
    fs.writeFileSync(path.join(dir, "node_modules/@openai/codex/bin/codex.js"), "unused");
    assert.deepEqual(codexCommand({ PATH: dir }, "win32"), { command: process.execPath, args: [path.join(dir, "node_modules/@openai/codex/bin/codex.js"), "app-server"] });
    fs.writeFileSync(path.join(dir, "codex"), "unused");
    const portableDir = path.relative(process.cwd(), dir);
    assert.equal(codexCommand({ PATH: portableDir }, "darwin").command, path.join(portableDir, "codex"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("RPC initializes, ignores notifications and fragmented lines, then reads quota without starting a turn", async () => {
  const script = `const readline=require('node:readline'); readline.createInterface({input:process.stdin}).on('line',line=>{
    const r=JSON.parse(line);
    if(r.method==='initialize') process.stdout.write(JSON.stringify({id:1,result:{}})+'\\n');
    else if(r.method==='account/rateLimits/read') { process.stdout.write('{"method":"notice"}\\n'+ '{"id":2,"result":'); setTimeout(()=>process.stdout.write('{"rateLimits":{"primary":{"usedPercent":37}}}}\\n'),20); }
    else if(r.method!=='initialized') process.exit(1);
  });`;
  const value = await readCodex({ command: process.execPath, args: ["-e", script] }, 3000);
  assert.equal(value.windows[0].remaining, 63);
});

test("RPC failures are bounded and provider diagnostics are never surfaced", async () => {
  await assert.rejects(readCodex({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] }, 60), /timeout/);
  const script = `process.stdin.on('data',()=>process.stdout.write(JSON.stringify({id:1,error:{message:'SECRET'}})+'\\n'))`;
  await assert.rejects(readCodex({ command: process.execPath, args: ["-e", script] }, 3000), /^Error: unavailable$/);
});

function harness() {
  const source = fs.readFileSync(path.join(__dirname, "../defaults/mods/workspace-status/quota.js"), "utf8").replace(/^import .*;\r?\n/gm, "").replace(/export /g, "");
  let focus = { terminal: "t1", space: "s1" }, paneList = [{ terminal: "t1", app: "codex" }], spaceList = [{ id: "s1" }];
  const requests = [], tasks = [], notify = () => {};
  const element = () => {
    const node = { children: [], child(value) { this.children.push(value); return this; }, tooltip(value) { this.tip = value; return this; }, on_click(value) { this.click = value; return this; } };
    for (const method of ["id", "gap", "items_center", "flex_none", "px", "rounded", "hover", "text_color"]) node[method] = () => node;
    return node;
  };
  const english = (text, values = []) => text.replace(/\{(\d+)\}/g, (_, i) => String(values[i]));
  const api = new Function("focused", "panes", "agents", "spaces", "exec", "tr", "div", "h_flex", source + ";return {Quota,quotaTarget};")(
    () => focus, () => paneList, () => [], () => spaceList,
    (...args) => new Promise(resolve => requests.push({ args, resolve })), english, element, element);
  const quota = new api.Quota(); quota.probe = "test";
  const cx = { spawn: fn => tasks.push(fn({ notify })), notify };
  return { ...api, quota, cx, requests, tasks, setFocus: f => { focus = f; }, setPanes: p => { paneList = p; } };
}

test("focus, shown terminal and remote account boundaries", () => {
  const { quotaTarget } = harness();
  assert.equal(quotaTarget({ terminal: null }, [], [], []), null);
  assert.equal(quotaTarget({ terminal: "t1", space: "s1" }, [{ terminal: "t1", app: "codex" }], [], [{ id: "s1", machine: "server" }]).remote, true);
  assert.equal(quotaTarget({ terminal: "t1", shown: "t2" }, [], [{ address: "t2", app: "claude-code" }], []).provider, "claude");
});

test("status bar shows remaining quota, last update and reset time; a click refreshes", async () => {
  const h = harness(), now = Date.now();
  h.quota.cache["local:codex"] = { status: "ok", windows: [{ remaining: 94, minutes: 10080, resetsAt: now + 86400000 }], updatedAt: now, attemptedAt: now };
  const row = h.quota.render(h.cx, {});
  const text = node => typeof node === "string" ? node : node.children.map(text).join(" ");
  assert.match(text(row), /Codex Weekly 94% left/);
  assert.match(row.tip, /Updated:/);
  assert.match(row.tip, /Weekly resets:/);
  assert.equal(h.requests.length, 0);
  row.click({}, h.cx);
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve({ code: 0, stdout: JSON.stringify({ status: "ok", windows: [{ remaining: 93, minutes: 10080 }] }) });
  await Promise.all(h.tasks);
  assert.match(text(h.quota.render(h.cx, {})), /93% left/);
});

test("remote focus never probes the local account; rate limits back off for two minutes", () => {
  const h = harness();
  h.setFocus({ terminal: "server/t1" });
  h.setPanes([{ terminal: "server/t1", app: "codex" }]);
  h.quota.refresh(h.cx, true);
  assert.equal(h.requests.length, 0);
  h.setFocus({ terminal: "t1" }); h.setPanes([{ terminal: "t1", app: "codex" }]);
  h.quota.cache["local:codex"] = { status: "rate-limited", windows: [], attemptedAt: Date.now() - 60000 };
  h.quota.refresh(h.cx);
  assert.equal(h.requests.length, 0);
});

test("DeepSeek status bar displays account money and its breakdown, including exhausted accounts", () => {
  const h = harness(), now = Date.now();
  h.setPanes([{ terminal: "t1", app: "claude-code" }]);
  h.quota.cache["local:claude"] = { ...deepseekBalance(deepseekReply), attemptedAt: now };
  const text = node => typeof node === "string" ? node : node.children.map(text).join(" ");
  const row = h.quota.render(h.cx, {});
  assert.match(text(row), /DeepSeek Balance ¥25\.42/);
  assert.doesNotMatch(text(row), /Sign in|%/);
  assert.match(row.tip, /Top-up balance: ¥25\.42/);
  assert.match(row.tip, /Granted balance: ¥0\.00/);
  assert.match(row.tip, /Updated:/);
  h.quota.cache["local:claude"] = { ...deepseekBalance({ is_available: false, balance_infos: [{ currency: "CNY", total_balance: "0.00" }] }), attemptedAt: now };
  assert.match(text(h.quota.render(h.cx, {})), /Balance ¥0\.00/);
  assert.match(h.quota.render(h.cx, {}).tip, /No balance available for API calls/);
  h.quota.cache["local:claude"] = { provider: "deepseek", status: "api-key-invalid", windows: [], attemptedAt: now };
  assert.match(text(h.quota.render(h.cx, {})), /DeepSeek API key invalid or expired/);
});

test("deduplicates concurrent refreshes and keeps late replies in their own provider cache", async () => {
  const h = harness();
  h.quota.refresh(h.cx); h.quota.refresh(h.cx, true);
  assert.equal(h.requests.length, 1);
  h.setPanes([{ terminal: "t1", app: "claude-code" }]); h.quota.refresh(h.cx);
  assert.equal(h.requests.length, 2);
  h.requests[1].resolve({ code: 0, stdout: JSON.stringify({ status: "ok", windows: [{ remaining: 80 }] }) });
  h.requests[0].resolve({ code: 0, stdout: JSON.stringify({ status: "ok", windows: [{ remaining: 15 }] }) });
  await Promise.all(h.tasks);
  assert.equal(h.quota.cache["local:claude"].windows[0].remaining, 80);
  h.quota.refresh(h.cx);
  assert.equal(h.requests.length, 2);
  h.quota.refresh(h.cx, true);
  h.requests[2].resolve({ code: 1, stdout: "" });
  await Promise.all(h.tasks);
  assert.deepEqual(h.quota.cache["local:claude"].windows, []);
});
