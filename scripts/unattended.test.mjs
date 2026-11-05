import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { answerQuestion, answerQuestions, answerForm, codexDecision, claudeDecision, asksToContinue, exceptionFor } from "../defaults/mods/unattended/policy.mjs";
import { Supervisor } from "../defaults/mods/unattended/supervisor.mjs";
import { run } from "../defaults/mods/unattended/runner.mjs";
import { startProcess, childEnvironment } from "../defaults/mods/unattended/transport.mjs";

// Compare protocol values as JSON, where object prototypes have no meaning.
function protocol(actual, expected) { assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected); }

test("Codex approves one operation, including requested filesystem and network permissions", () => {
  assert.deepEqual(codexDecision("item/commandExecution/requestApproval", { command: "anything" }), { decision: "accept" });
  assert.deepEqual(codexDecision("item/fileChange/requestApproval", {}), { decision: "accept" });
  const permissions = { network: { enabled: true }, fileSystem: { write: ["/scratch"] } };
  assert.deepEqual(codexDecision("item/permissions/requestApproval", { permissions }), { permissions, scope: "turn" });
  assert.equal(codexDecision("item/commandExecution/requestApproval", { availableDecisions: ["decline", "cancel"] }), null);
  assert.equal(codexDecision("future/request", {}), null);
});

test("questions default to Yes, then recommendation, then the offered default; secret values are not fabricated", () => {
  assert.equal(answerQuestion({ options: [{ label: "No (Recommended)" }, { label: "Yes, proceed" }] }), "Yes, proceed");
  assert.equal(answerQuestion({ options: [{ label: "A" }, { label: "B (Recommended)" }] }), "B (Recommended)");
  assert.equal(answerQuestion({ options: [{ label: "Configured phone" }, { label: "Other phone" }] }), "Configured phone");
  assert.equal(answerQuestion({ options: [{ label: "拒绝" }, { label: "允许执行" }] }), "允许执行");
  assert.equal(answerQuestion({ question: "May I use the password manager?", options: [{ label: "Yes" }] }), "Yes");
  assert.equal(answerQuestion({ question: "Enter your password", isSecret: true }), null);
  assert.equal(answerQuestion({ question: "请在 ProfilePilot 点击交还控制", options: [{ label: "已交还控制" }, { label: "暂时不方便" }] }), null);
  assert.equal(answerQuestion({ question: "May I operate the configured phone?", options: [{ label: "Yes" }] }), "Yes");
  assert.equal(answerQuestions([{ id: "secret", isSecret: true }], "codex"), null);
});

test("Claude permission and question replies preserve the input and return actual answers", () => {
  const request = { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [{ question: "Continue?", options: [{ label: "Yes" }] }], extra: "retain" } };
  protocol(claudeDecision(request), { behavior: "allow", updatedInput: { ...request.input, answers: { "Continue?": "Yes" } } });
  assert.deepEqual(claudeDecision({ subtype: "can_use_tool", tool_name: "MCP__phone", input: { action: "tap" } }), { behavior: "allow", updatedInput: { action: "tap" } });
});

test("MCP form approvals use supplied data; missing values and URL authentication remain pending", () => {
  const schema = { type: "object", properties: { confirm: { type: "boolean" }, device: { type: "string", default: "configured" } }, required: ["confirm", "device"] };
  protocol(answerForm(schema), { confirm: true, device: "configured" });
  assert.equal(answerForm({ type: "object", properties: { address: { type: "string" } }, required: ["address"] }), null);
  assert.equal(answerForm({ type: "object", properties: { password: { type: "string", default: "secret" } } }), null);
  protocol(claudeDecision({ subtype: "elicitation", requested_schema: schema }), { action: "accept", content: { confirm: true, device: "configured" } });
  assert.equal(codexDecision("mcpServer/elicitation/request", { mode: "url", url: "https://example.com/login" }), null);
  assert.equal(codexDecision("mcpServer/elicitation/request", { mode: "form", message: "Please return control in the app", requestedSchema: schema }), null);
});

function harness(options = {}) {
  const log = [], sent = [], states = [];
  const s = new Supervisor({ audit: event => log.push(event), output() {}, state: status => states.push(status), ...options });
  s.adapter = { submit: async text => sent.push(text) };
  const request = (id = 1, params = { command: "node check.js" }) => ({ id, kind: "permission", params, automatic: () => ({ allow: true }), approve: () => ({ allow: true }), deny: () => ({ allow: false }), respond: response => sent.push(response) });
  return { s, log, sent, states, request };
}

test("Windows child PATH keeps existing entries and order without duplicate or stale shim directories", () => {
  const directory = mkdtempSync(join(tmpdir(), "herdr-path-"));
  const env = { Path: `${directory};${directory};${join(directory, "missing")}`, KEEP: "value" };
  assert.deepEqual(childEnvironment(env, "win32"), { Path: directory, KEEP: "value" });
  assert.deepEqual(childEnvironment(env, "linux"), env);
  assert.notEqual(env.Path, directory);
});

test("question IDs remain data even when they name JavaScript object properties", () => {
  const answer = answerQuestions([{ id: "__proto__", options: [{ label: "Yes" }] }], "codex");
  assert.equal(JSON.parse(JSON.stringify(answer))["__proto__"].answers[0], "Yes");
});

test("an approval is journaled once before sending, including replayed request IDs", () => {
  const { s, log, sent, request } = harness();
  const r = request();
  r.respond = response => { assert.equal(log[0].type, "decision"); sent.push(response); };
  s.request(r); s.request(r);
  assert.equal(sent.length, 1); assert.equal(s.pending.size, 0);
  const broken = harness({ audit() { throw new Error("disk full"); } });
  assert.throws(() => broken.s.request(broken.request()), /disk full/);
  assert.equal(broken.sent.length, 0);
});

test("exceptions are literal, take precedence over Yes, and can be manually approved once", () => {
  assert.equal(exceptionFor("GIT PUSH", ["git push"]), "git push");
  assert.equal(exceptionFor("delete", [".*"]), null);
  const { s, sent, request } = harness({ exceptions: ["git push"] });
  s.request(request(1, { command: "git push origin master" }));
  assert.equal(sent.length, 0); assert.equal(s.status, "blocked");
  s.manual(1, "allow");
  assert.deepEqual(sent, [{ allow: true }]);
});

test("turning automation off prevents new replies; turning it on handles pending requests without duplicates", () => {
  const { s, sent, request } = harness();
  s.configure(false, []); s.request(request()); s.request(request());
  assert.equal(sent.length, 0); assert.equal(s.pending.size, 1);
  s.configure(true, []); s.retryPending(); s.retryPending();
  assert.equal(sent.length, 1);
  s.configure(false, []); s.request(request(2)); s.resolved(2); s.configure(true, []); s.retryPending();
  assert.equal(sent.length, 1);
});

test("completed assistant confirmation questions continue automatically, interrupted or failed turns do not", async () => {
  const { s, sent } = harness();
  await s.finished({ status: "completed", text: "Would you like me to finish the remaining work?" });
  assert.equal(sent.length, 1);
  await s.finished({ status: "interrupted", text: "Should I continue?" });
  await s.finished({ status: "failed", text: "Should I continue?" });
  assert.equal(sent.length, 1);
  await s.finished({ status: "completed", text: "The result is complete and verified." });
  assert.equal(s.status, "done");
  assert(asksToContinue("我已经准备好，是否继续操作手机？"));
  assert(asksToContinue("Ready to run. Please confirm before I proceed."));
  assert(asksToContinue("Reply with `yes` to continue."));
  assert(asksToContinue("操作已准备好，等待你的确认。"));
  assert(asksToContinue("请回复“继续”，我就开始操作。"));
  assert(!asksToContinue("Please return control in ProfilePilot. Shall I continue after that?"));
  assert(!asksToContinue('Done. The guide uses the example "Would you like me to continue?".'));
  assert(!asksToContinue("Done. Example:\n```text\nWould you like me to continue?\n```"));
});

test("a repeated continuation loop and an excepted confirmation are reported as incomplete", async () => {
  const { s, sent } = harness();
  for (let i = 0; i < 3; i++) await s.finished({ status: "completed", text: "Shall I continue?" });
  assert.equal(sent.length, 2); assert.equal(s.status, "blocked");
  s.configure(true, ["publish"]);
  await s.finished({ status: "completed", text: "Shall I publish?" });
  assert.equal(s.status, "blocked"); assert.equal(sent.length, 2);
  await s.finished({ status: "completed", text: "Please return control in ProfilePilot. Shall I continue after that?" });
  assert.equal(s.status, "blocked"); assert.equal(sent.length, 2);
});

for (const engine of ["codex", "claude"]) test(`${engine}: real stdio round trip, two approvals, conversational continuation, journal and shutdown`, { timeout: 15000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), `herdr-unattended-${engine}-`));
  const config = join(directory, "task.json");
  writeFileSync(config, JSON.stringify({ agent: engine, task: "test task", cwd: directory }));
  let text = "";
  const input = new PassThrough();
  const output = new Writable({ write(chunk, encoding, callback) { text += chunk; callback(); } });
  const code = await run(config, { once: true, input, output, transportFactory: (agent, options) => startProcess(agent, { ...options, launch: () => spawn(process.execPath, [fileURLToPath(new URL("./fixtures/unattended-peer.mjs", import.meta.url)), agent], { stdio: ["pipe", "pipe", "pipe"] }) }) });
  input.end(); output.end();
  assert.equal(code, 0, text);
  const log = readFileSync(join(directory, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(log.filter(x => x.type === "decision").length, 2);
  assert.equal(log.filter(x => x.type === "continuation").length, 1);
  assert.equal(JSON.parse(readFileSync(join(directory, "state.json"), "utf8")).status, "done");
  assert.match(text, /Task complete/);
  await assert.rejects(run(config, { input: new PassThrough(), output }), /EEXIST/);
});
