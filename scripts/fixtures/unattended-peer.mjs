// A protocol peer, not a language model. It refuses incorrect approval replies.
import { createInterface } from "node:readline";
import assert from "node:assert/strict";
const engine = process.argv[2];
const resume = process.argv[3];
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const pending = new Map();
let turn = 0;
function codex(method, params) { send({ method, params: { threadId: "thread-test", ...params } }); }
function request(id, method, params, expected) {
  pending.set(id, expected);
  if (engine === "codex") send({ id, method, params: { threadId: "thread-test", turnId: `turn-${turn}`, ...params } });
  else send({ type: "control_request", request_id: id, request: params });
}
function finish(text) {
  if (engine === "codex") {
    codex("item/completed", { item: { type: "agentMessage", id: `message-${turn}`, text } });
    codex("turn/completed", { turn: { id: `turn-${turn}`, status: "completed" } });
  } else {
    send({ type: "assistant", message: { content: [{ type: "text", text }] } });
    send({ type: "result", subtype: "success", result: text, is_error: false });
  }
}
function task(text) {
  turn++;
  if (engine === "codex") codex("turn/started", { turn: { id: `turn-${turn}`, status: "inProgress" } });
  if (turn === 2) {
    assert.match(text, /Yes, proceed/);
    finish("Task complete: the requested result was verified."); return;
  }
  assert.match(text, /test task/);
  if (engine === "codex") {
    request(101, "item/commandExecution/requestApproval", { command: "test command", itemId: "cmd-1" }, { decision: "accept" });
    request(102, "item/tool/requestUserInput", { questions: [{ id: "phone", question: "May I use the configured phone?", options: [{ label: "Yes", description: "Proceed" }, { label: "No", description: "Stop" }] }] }, { answers: { phone: { answers: ["Yes"] } } });
  } else {
    request("101", null, { subtype: "can_use_tool", tool_name: "Bash", input: { command: "test command" } }, { behavior: "allow", updatedInput: { command: "test command" } });
    request("102", null, { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [{ question: "May I use the configured phone?", options: [{ label: "Yes" }, { label: "No" }] }] } }, { behavior: "allow", updatedInput: { questions: [{ question: "May I use the configured phone?", options: [{ label: "Yes" }, { label: "No" }] }], answers: { "May I use the configured phone?": "Yes" } } });
  }
}
createInterface({ input: process.stdin }).on("line", line => {
  try {
    const m = JSON.parse(line);
    if (engine === "codex") {
      if (m.method === "initialize") { send({ id: m.id, result: { userAgent: "fixture" } }); return; }
      if (m.method === "initialized") return;
      if (m.method === "thread/start" || m.method === "thread/resume") {
        assert.equal(m.method, resume ? "thread/resume" : "thread/start");
        if (resume) { assert.equal(m.params.threadId, resume); assert.equal(m.params.excludeTurns, true); }
        send({ id: m.id, result: { thread: { id: "thread-test" } } }); return;
      }
      if (m.method === "turn/start") { send({ id: m.id, result: { turn: { id: `turn-${turn + 1}` } } }); task(m.params.input[0].text); return; }
      assert(pending.has(m.id), `unexpected response ${m.id}`);
      assert.deepEqual(m.result, pending.get(m.id)); pending.delete(m.id);
    } else {
      if (m.type === "control_request" && m.request.subtype === "initialize") {
        send({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } });
        send({ type: "system", subtype: "init", session_id: resume || "claude-test" }); return;
      }
      if (m.type === "user") { task(m.message.content); return; }
      assert(pending.has(m.response.request_id));
      assert.deepEqual(m.response.response, pending.get(m.response.request_id)); pending.delete(m.response.request_id);
    }
    if (!pending.size) finish("Would you like me to continue and verify the result?");
  } catch (error) { process.stderr.write(error.stack); process.exitCode = 1; process.stdin.destroy(); }
});
