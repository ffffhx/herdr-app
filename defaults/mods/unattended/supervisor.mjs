import { CONTINUE, asksToContinue, exceptionFor } from "./policy.mjs";

export class Supervisor {
  constructor({ enabled = true, exceptions = [], audit, output, state, refresh = () => {} }) {
    this.enabled = enabled;
    this.exceptions = exceptions;
    this.audit = audit; this.output = output; this.state = state; this.refresh = refresh;
    this.pending = new Map(); this.answered = new Set(); this.repeated = new Map();
    this.status = "idle";
  }
  setState(status) { this.status = status; this.state(status); }
  request(request) {
    const id = String(request.id);
    if (this.answered.has(id) || this.pending.has(id)) return;
    this.pending.set(id, request);
    this.tryAutomatic(request);
  }
  tryAutomatic(request) {
    this.refresh();
    const exception = exceptionFor({ kind: request.kind, ...request.params }, this.exceptions);
    const response = request.automatic();
    if (this.enabled && !exception && response !== null) {
      this.respond(request, response, "automatic");
    } else {
      const reason = !this.enabled ? "Automatic approval is off" : exception ? `Exception: ${exception}` : "Input required";
      this.audit({ type: "pending", id: String(request.id), kind: request.kind, reason, request: request.params });
      this.output(`\n[Herdr] ${reason} — request ${request.id}\n${JSON.stringify(request.params, null, 2)}\nUse /allow ${request.id}, /deny ${request.id}, or /answer ${request.id} <answer>.\n`);
      this.setState("blocked");
    }
  }
  respond(request, response, source) {
    const id = String(request.id);
    if (!this.pending.has(id) || this.answered.has(id)) return;
    // Commit the audit before replying. A failed log must not cause a silent approval.
    this.audit({ type: "decision", id, kind: request.kind, source, request: request.params, response });
    this.pending.delete(id);
    this.answered.add(id);
    request.respond(response);
    this.output(`\n[Herdr] ${source}: ${request.kind} (${id})\n`);
    this.setState(this.pending.size ? "blocked" : "working");
  }
  resolved(id) {
    const removed = this.pending.delete(String(id));
    if (removed && !this.pending.size && this.status === "blocked") this.setState("working");
  }
  clearRequests() { this.pending.clear(); }
  configure(enabled, exceptions) {
    const changed = this.enabled !== enabled || JSON.stringify(this.exceptions) !== JSON.stringify(exceptions);
    this.enabled = enabled; this.exceptions = exceptions;
    if (!changed) return;
    this.audit({ type: "policy", enabled, exceptions });
    this.state(this.status);
  }
  retryPending() {
    for (const r of [...this.pending.values()]) {
      if (this.enabled && !exceptionFor({ kind: r.kind, ...r.params }, this.exceptions) && r.automatic() !== null) this.tryAutomatic(r);
    }
  }
  manual(id, action, answer) {
    const request = this.pending.get(String(id));
    if (!request) throw new Error(`No pending request ${id}`);
    let response;
    if (action === "deny") response = request.deny();
    else if (action === "allow") response = request.approve();
    else {
      let parsed;
      try { parsed = JSON.parse(answer); } catch { /* Plain answers are supported for question tools. */ }
      const questions = request.params.questions ?? request.params.input?.questions;
      if (questions) {
        const answers = Object.create(null);
        for (const q of questions) {
          const key = q.id ?? q.question;
          const value = parsed && typeof parsed === "object" ? parsed[key] : answer;
          if (typeof value !== "string" || !value.trim()) throw new Error(`Provide an answer for ${key}`);
          answers[key] = request.kind === "can_use_tool" ? value : { answers: [value] };
        }
        response = request.kind === "can_use_tool" ? { behavior: "allow", updatedInput: { ...request.params.input, answers } } : { answers };
      } else if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) response = parsed;
      else throw new Error("This request needs a JSON response object");
    }
    if (response === null) throw new Error("This request needs an answer; use /answer");
    this.respond(request, response, "user");
  }
  async finished({ text, status, error }) {
    this.refresh();
    this.audit({ type: "turn", status, error });
    if (status !== "completed") { this.setState(status === "interrupted" ? "idle" : "error"); if (error) this.output(`\n[Herdr] ${error}\n`); return; }
    if (this.enabled && asksToContinue(text) && !exceptionFor(text, this.exceptions)) {
      const fingerprint = text.trim().replace(/\s+/g, " ");
      const times = (this.repeated.get(fingerprint) ?? 0) + 1;
      this.repeated.set(fingerprint, times);
      if (times > 2) {
        this.audit({ type: "stalled", reason: "The agent repeated the same continuation question without progressing" });
        this.output("\n[Herdr] The agent repeated the same question after two automatic replies. Task is still incomplete. Enter guidance to continue.\n");
        this.setState("blocked"); return;
      }
      this.audit({ type: "continuation", question: text, answer: CONTINUE });
      this.output("\n[Herdr] Automatically confirmed continuation.\n");
      this.setState("working");
      await this.adapter.submit(CONTINUE);
      return;
    }
    this.setState(asksToContinue(text) ? "blocked" : "done");
  }
}
