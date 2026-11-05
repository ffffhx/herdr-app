import { Requests } from "./transport.mjs";
import { codexDecision, claudeDecision } from "./policy.mjs";

export class Codex {
  constructor(host) {
    this.host = host;
    this.rpc = new Requests(message => host.send(message));
    this.messages = new Map();
    this.activeTurn = null;
  }
  async initialize(cwd, resumeSessionId) {
    this.thread = resumeSessionId;
    await this.rpc.call("initialize", { clientInfo: { name: "herdr_unattended", title: "Herdr unattended", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    this.host.send({ method: "initialized", params: {} });
    const result = await this.rpc.call(resumeSessionId ? "thread/resume" : "thread/start", {
      cwd, approvalPolicy: "on-request", approvalsReviewer: "user",
      ...(resumeSessionId ? { threadId: resumeSessionId, excludeTurns: true } : {}),
    });
    this.thread = result.thread.id;
    if (resumeSessionId && this.thread !== resumeSessionId) throw new Error("Codex resumed a different conversation");
    this.host.session(this.thread);
  }
  async submit(text) {
    const input = [{ type: "text", text, text_elements: [] }];
    if (this.activeTurn) {
      await this.rpc.call("turn/steer", { threadId: this.thread, expectedTurnId: this.activeTurn, input });
    } else {
      await this.rpc.call("turn/start", { threadId: this.thread, input });
    }
  }
  async interrupt() {
    if (this.activeTurn) await this.rpc.call("turn/interrupt", { threadId: this.thread, turnId: this.activeTurn });
  }
  async receive(message) {
    if (this.rpc.receive(message)) return;
    const p = message.params ?? {};
    if (p.threadId && this.thread && p.threadId !== this.thread) return;
    if (message.id !== undefined && message.method) {
      this.host.request({
        id: message.id, kind: message.method, params: p,
        automatic: () => codexDecision(message.method, p),
        approve: () => codexDecision(message.method, p),
        deny: () => message.method.includes("permissions/") ? { permissions: {}, scope: "turn" }
          : message.method === "mcpServer/elicitation/request" ? { action: "decline", content: null }
          : message.method.includes("requestUserInput") ? { answers: {} } : { decision: "decline" },
        respond: result => this.host.send({ id: message.id, result }),
      });
      return;
    }
    switch (message.method) {
      case "turn/started":
        this.activeTurn = p.turn.id; this.messages.clear(); this.finalText = "";
        this.host.state("working"); break;
      case "item/agentMessage/delta":
        this.messages.set(p.itemId, (this.messages.get(p.itemId) ?? "") + p.delta);
        this.host.output(p.delta); break;
      case "item/commandExecution/outputDelta": this.host.output(p.delta); break;
      case "item/started":
        if (p.item.type === "commandExecution") this.host.notice(`$ ${p.item.command}`);
        else if (p.item.type === "mcpToolCall") this.host.notice(`${p.item.server}/${p.item.tool}`);
        break;
      case "item/completed":
        if (p.item.type === "agentMessage") {
          if (!this.messages.has(p.item.id)) this.host.output(p.item.text ?? "");
          this.host.output("\n");
          this.finalText = p.item.text ?? this.messages.get(p.item.id) ?? "";
        }
        break;
      case "serverRequest/resolved": this.host.resolved(p.requestId); break;
      case "turn/completed":
        this.activeTurn = null;
        this.host.clearRequests();
        await this.host.finished({ text: this.finalText ?? "", status: p.turn.status, error: p.turn.error?.message });
        break;
      case "error": this.host.notice(`${p.willRetry ? "Retrying" : "Error"}: ${p.error?.message ?? JSON.stringify(p)}`); break;
    }
  }
  close() { this.rpc.close(); }
}

export class Claude {
  constructor(host) {
    this.host = host;
    this.next = 1;
    this.calls = new Map();
    this.finalText = "";
  }
  control(request) {
    const request_id = `herdr-${this.next++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.calls.delete(request_id); reject(new Error(`${request.subtype} timed out; outcome unknown`)); }, 60000);
      this.calls.set(request_id, { resolve, reject, timer });
      this.host.send({ type: "control_request", request_id, request });
    });
  }
  async initialize(_cwd, resumeSessionId) { this.expectedSession = resumeSessionId; await this.control({ subtype: "initialize", hooks: {} }); }
  async submit(text) {
    this.finalText = "";
    this.host.state("working");
    this.host.send({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: this.session ?? "" });
  }
  async interrupt() { await this.control({ subtype: "interrupt" }); }
  async receive(message) {
    if (message.type === "control_response") {
      const response = message.response;
      const pending = this.calls.get(response?.request_id);
      if (pending) {
        clearTimeout(pending.timer); this.calls.delete(response.request_id);
        response.subtype === "error" ? pending.reject(new Error(response.error)) : pending.resolve(response.response);
      }
      return;
    }
    if (message.type === "control_cancel_request") { this.host.resolved(message.request_id); return; }
    if (message.type === "control_request") {
      const r = message.request;
      this.host.request({
        id: message.request_id, kind: r.subtype, params: r,
        automatic: () => claudeDecision(r), approve: () => claudeDecision(r),
        deny: () => r.subtype === "elicitation" ? { action: "decline" } : { behavior: "deny", message: "Declined by the user. Continue independent work within the existing task restrictions." },
        respond: response => this.host.send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response } }),
      });
      return;
    }
    if (message.type === "system" && message.subtype === "init") {
      this.session = message.session_id;
      if (this.expectedSession && this.session !== this.expectedSession) throw new Error("Claude resumed a different conversation");
      this.host.session(this.session);
    }
    if (message.type === "assistant") {
      for (const block of message.message?.content ?? []) {
        if (block.type === "text") { this.host.output(`${block.text}\n`); this.finalText = block.text; }
        if (block.type === "tool_use") this.host.notice(`${block.name}: ${JSON.stringify(block.input).slice(0,1200)}`);
      }
    }
    if (message.type === "result") {
      this.host.clearRequests();
      await this.host.finished({ text: message.result ?? this.finalText, status: message.is_error ? "failed" : "completed", error: message.is_error ? (message.errors ?? [message.result]).join("\n") : undefined });
    }
  }
  close() {
    for (const c of this.calls.values()) { clearTimeout(c.timer); c.reject(new Error("Agent connection closed")); }
    this.calls.clear();
  }
}
