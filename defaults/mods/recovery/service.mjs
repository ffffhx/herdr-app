import { mkdirSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { Core } from "./core.mjs";
import { DOC, keyOf, managed, agentOf, shellOf, commandLine, emptyPrompt, eligible, duplicateSessions } from "./model.mjs";
import { install, atomic } from "./install.mjs";
import { rootTranscript, verifyResume } from "./hook.mjs";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { if (!Number.isInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const sources = () => ["service.mjs", "model.mjs", "core.mjs", "install.mjs", "hook.mjs"].map(file => readFileSync(new URL(file, import.meta.url), "utf8")).join("\0");
export class Recovery {
  constructor(core, home, { now = Date.now, sleep = delay, verify = verifyResume } = {}) { Object.assign(this, { core, home, now, sleep, verify }); this.shellSince = new Map(); }
  async change(key, change) {
    return this.core.update(DOC, doc => {
      if (!doc?.records?.[key]) return;
      doc.records[key] = change(doc.records[key]);
      return doc;
    });
  }
  async recover(term, record, generation) {
    const key = keyOf(term), stamp = randomUUID();
    const claimed = await this.core.update(DOC, doc => {
      const current = doc?.records?.[key];
      if (doc.enabled === false || !eligible(term, current, generation)) return;
      if (current.sessionId !== record.sessionId || current.agent !== record.agent || current.transcript !== record.transcript || current.pid !== record.pid || current.generation !== record.generation) return;
      doc.records[key] = { ...current, state: "restoring", error: null, attempt: { pid: term.pid, generation, stamp, at: this.now(), state: "claimed" } };
      return doc;
    });
    if (claimed?.records?.[key]?.attempt?.stamp !== stamp) return;
    let sent = false;
    try {
      if (!existsSync(record.transcript)) throw new Error("The original conversation file is missing");
      if (!rootTranscript(record.agent, { session_id: record.sessionId, transcript_path: record.transcript })) throw new Error("The conversation file does not match the saved root session");
      const fresh = await this.core.call("terminal.get", { terminal: term.address });
      if (fresh.pid !== term.pid || keyOf(fresh) !== key || agentOf(fresh) || !shellOf(fresh) || fresh.state !== "live" || (fresh.foreground?.pid && fresh.foreground.pid !== fresh.pid)) throw new Error("The terminal changed before recovery");
      if (realpathSync(fresh.foreground?.cwd || fresh.cwd) !== realpathSync(record.cwd)) throw new Error("The terminal is no longer in the saved working folder");
      const screen = await this.core.call("terminal.read", { terminal: term.address, lines: 0 });
      if (!emptyPrompt(screen.text, shellOf(fresh))) throw new Error("The shell has input or an unrecognized prompt. Clear it before retrying.");
      const current = (await this.core.call("doc.get", { name: DOC })).value;
      if (current?.enabled === false || current?.records?.[key]?.attempt?.stamp !== stamp || current.records[key].sessionId !== record.sessionId) throw new Error("The recovery request changed before input was sent");
      // Never clear a composer or send a prompt. This starts only a native
      // resume command in a newly recovered shell, with the exact saved ID.
      sent = true;
      await this.core.call("terminal.send", { terminal: term.address, text: commandLine(record, shellOf(fresh)) });
      await this.change(key, r => r.attempt?.stamp !== stamp ? r : ({ ...r, attempt: { ...r.attempt, state: "sent" } }));
    } catch (error) {
      await this.change(key, r => r.attempt?.stamp !== stamp ? r : ({ ...r, state: "failed", error: error.message, attempt: { ...r.attempt, state: sent ? "unknown" : "not-sent" } }));
    }
  }
  async tick() {
    const [listing, saved, server] = await Promise.all([this.core.call("terminal.list", { all: true }), this.core.call("doc.get", { name: DOC }), this.core.call("server.status")]);
    const generation = server.holder?.instance;
    if (!generation) return;
    const records = saved.value?.records || {}, all = listing.terminals.filter(managed);
    const present = new Set(all.map(keyOf));
    // A missing binding must be visible before a reboot, and remain visible
    // afterwards. These diagnostics never stand in for a verified session ID.
    const uncaptured = { ...(saved.value?.uncaptured || {}) };
    for (const [key, row] of Object.entries(uncaptured)) {
      if (!present.has(key) || all.find(t => keyOf(t) === key)?.state === "finished" || (records[key] && !records[key].closed)) delete uncaptured[key];
    }
    for (const term of all) {
      const key = keyOf(term), agent = agentOf(term);
      if (term.state !== "live" || !agent || (records[key] && !records[key].closed)) continue;
      uncaptured[key] = { key, terminal: term.address, created: term.created_ms, agent, cwd: term.cwd, state: "uncaptured" };
    }
    if (JSON.stringify(uncaptured) !== JSON.stringify(saved.value?.uncaptured || {})) {
      await this.core.update(DOC, doc => {
        doc ||= { version: 1, records: {} };
        // A hook may have saved its binding while the diagnostic was prepared.
        doc.uncaptured = Object.fromEntries(Object.entries(uncaptured).filter(([key]) => !doc.records?.[key] || doc.records[key].closed));
        return doc;
      });
    }
    for (const [key, record] of Object.entries(records)) {
      if (!present.has(key) && !record.closed && record.captured < this.now() - 30000) await this.change(key, r => ({ ...r, closed: true, state: "closed" }));
    }
    const duplicates = duplicateSessions(records, all);
    for (const term of all) {
      const key = keyOf(term);
      let record = records[key];
      // Policy can change between agent turns; persist it without requiring a
      // new provider hook. A prior enabled policy survives a dead observer.
      const control = term.labels?.["herdr.unattended.control"];
      if (record && agentOf(term) === record.agent && control) {
        try {
          const policy = JSON.parse(readFileSync(control, "utf8"));
          if (typeof policy.enabled === "boolean" && (record.unattended !== policy.enabled || record.unattendedControl !== control)) {
            await this.change(key, r => ({ ...r, unattended: policy.enabled, unattendedControl: control }));
            record = { ...record, unattended: policy.enabled, unattendedControl: control };
          }
        } catch {}
      }
      // Old persisted badges cannot claim that a dead observer is active.
      if (term.labels?.["herdr.unattended"] === "on") {
        const control = term.labels["herdr.unattended.control"];
        let state;
        try { state = JSON.parse(readFileSync(control?.replace(/control\.json$/, "state.json"), "utf8")); } catch {}
        if (!state?.running || state.terminal !== term.address || state.sourceCreated !== term.created_ms || this.now() - state.updated > 15000) {
          await this.core.call("terminal.label", { terminal: term.address, labels: { "herdr.unattended": "off" } });
        }
      }
      if (!record) continue;
      if (term.state === "finished") { if (!record.closed) await this.change(key, r => ({ ...r, closed: true, state: "closed" })); continue; }
      // Some CLI versions defer SessionStart until the next user turn. Confirm
      // a newly resumed root by its exact native argv and ancestry, without
      // submitting an artificial prompt to make a hook run.
      if (record.attempt?.pid === term.pid && record.attempt?.generation === generation && ["restoring", "failed"].includes(record.state) && agentOf(term) === record.agent) {
        const verified = await this.verify(term, record);
        if (verified) {
          await this.change(key, r => r.sessionId !== record.sessionId ? r : ({ ...r, pid: term.pid, agentPid: verified.pid, generation, state: "ready", error: null }));
          record = { ...record, pid: term.pid, agentPid: verified.pid, generation, state: "ready", error: null };
        }
      }
      if (record.unattended && record.state === "ready" && record.attempt && agentOf(term) === record.agent && !record.attempt.observer) {
        await this.restoreObserver(term, record);
      }
      if (record.attempt?.observerDirectory) {
        let state;
        try { state = JSON.parse(readFileSync(join(record.attempt.observerDirectory, "state.json"), "utf8")); } catch {}
        const error = state?.error ? `Automatic approval observer: ${state.error}` : null;
        if (error && error !== record.error) await this.change(key, r => ({ ...r, error }));
      }
      if (record.state === "restoring" && record.attempt?.at + 45000 < this.now()) {
        await this.change(key, r => ({ ...r, state: "failed", error: "The agent did not confirm the original conversation. Inspect the terminal before retrying." }));
      }
      if (record.pid === term.pid && record.generation === generation && !agentOf(term) && !alive(record.agentPid) && shellOf(term)) {
        // An explicit native exit is final, but ignore the startup paint gap.
        const since = this.shellSince.get(key) || this.now(); this.shellSince.set(key, since);
        if (this.now() - since > 15000 && record.state === "ready") await this.change(key, r => ({ ...r, closed: true, state: "closed" }));
      } else this.shellSince.delete(key);
      if (saved.value?.enabled !== false && eligible(term, record, generation, duplicates)) await this.recover(term, record, generation);
    }
    const doc = await this.core.call("doc.get", { name: DOC });
    const missing = Object.values(doc.value?.uncaptured || {});
    const missingKeys = new Set(missing.map(r => r.key));
    const status = { updated: this.now(), enabled: doc.value?.enabled !== false, integrations: this.integrations || [], records: [...Object.values(doc.value?.records || {}).filter(r => !missingKeys.has(r.key)), ...missing] };
    atomic(join(this.home, "data/recovery/status.json"), status);
    return status;
  }
  async restoreObserver(term, record) {
    const key = keyOf(term);
    let policy;
    try { policy = JSON.parse(readFileSync(record.unattendedControl, "utf8")); } catch { return; }
    // Disabling approval is durable. Recovery never re-enables a user-disabled policy.
    if (policy.enabled !== true || !Array.isArray(policy.exceptions) || term.labels?.["herdr.unattended"] === "on") return;
    // Share the native observer's lease directory with manual attachments.
    const directory = join(this.home, "data/unattended/runs", `recovered-${term.address}-${term.pid}-${Date.now()}`);
    const config = { agent: record.agent, cwd: record.cwd, native: true, recovered: true, enabled: true, exceptions: policy.exceptions,
      source: { address: term.address, created_ms: term.created_ms, pid: term.pid, cwd: record.cwd, app: record.agent } };
    atomic(join(directory, "task.json"), config);
    const stamp = randomUUID();
    const claimed = await this.core.update(DOC, doc => {
      const r = doc?.records?.[key];
      if (!r?.attempt || r.attempt.observer || !r.unattended) return;
      doc.records[key] = { ...r, attempt: { ...r.attempt, observer: stamp, observerDirectory: directory } }; return doc;
    });
    if (claimed?.records?.[key]?.attempt?.observer !== stamp) return;
    try {
      await this.core.call("terminal.run", { argv: [process.execPath, join(this.home, "mods/unattended/native.mjs"), "--watch", "--config", join(directory, "task.json")],
        cwd: record.cwd, parent: term.address, no_notify: true, rm: true });
    } catch (error) { await this.change(key, r => ({ ...r, error: `Automatic approval observer: ${error.message}` })); }
  }
}

export async function requestRetry(core, key) {
  const saved = await core.call("doc.get", { name: DOC }), record = saved.value?.records?.[key];
  if (!record) throw new Error("No saved conversation for this terminal");
  const term = await core.call("terminal.get", { terminal: record.terminal });
  if (keyOf(term) !== key || term.state !== "live" || agentOf(term) || !shellOf(term)) throw new Error("Retry requires the original terminal to be an idle shell");
  if (record.attempt?.state === "unknown") throw new Error("The previous send has an unknown outcome; inspect the terminal before retrying");
  await core.update(DOC, doc => { const r = doc.records[key]; if (r.sessionId !== record.sessionId) throw new Error("The saved conversation changed"); doc.records[key] = { ...r, closed: false, attempt: null, state: "pending", error: null }; return doc; });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [mode, home, key] = process.argv.slice(2);
  const core = new Core();
  try {
    if (mode === "retry") await requestRetry(core, key);
    else if (mode === "enable" || mode === "disable") await core.update(DOC, doc => ({ ...(doc || { version: 1, records: {} }), enabled: mode === "enable" }));
    else if (mode === "status") console.log(JSON.stringify((await core.call("doc.get", { name: DOC })).value || { records: {} }));
    else if (mode === "serve") {
      mkdirSync(join(home, "data/recovery"), { recursive: true });
      const recovery = new Recovery(core, home);
      let nextInstall = 0;
      const originalSources = sources();
      // Finish the current tick before yielding to an updated bundled mod.
      // The app supervisor starts the replacement; claimed sends remain durable.
      while (!core.closed && sources() === originalSources) {
        try {
          // Repair launchers overwritten by older instances without restarting
          // agents, changing provider trust or waiting for the next app launch.
          if (Date.now() >= nextInstall) { recovery.integrations = install(home); nextInstall = Date.now() + 30000; }
          await recovery.tick();
        }
        catch (error) {
          console.error(error.message);
          try { atomic(join(home, "data/recovery/error.json"), { error: error.message, updated: Date.now() }); } catch {}
        }
        if (!core.closed) await delay(5000);
      }
    } else throw new Error("Expected serve, status, retry, enable, or disable");
  } catch (error) {
    if (home) { try { atomic(join(home, "data/recovery/error.json"), { error: error.message, updated: Date.now() }); } catch {} }
    console.error(error.message); process.exitCode = 1;
  } finally { core.close(); }
}
