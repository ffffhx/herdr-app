import { View, div } from "gpui-kit";
import { h_flex, v_flex, Input, InputState, Textarea, TextareaState } from "gpui-base";
import { tr, spaces, panes, props, run, theme, shared, setShared, readTextFile } from "herdr";
import { prepare, changePolicy, history, originalTerminal } from "./launch.js";

const HISTORY = "unattended.runs";
const STATUS = { working: "Working", blocked: "Needs input", done: "Done", idle: "Idle", error: "Error" };

export default class Unattended extends View {
  init(_props, cx) {
    const space = spaces().find(s => s.id === props()?.space) ?? spaces().find(s => s.active);
    this.space = space?.id;
    this.on = space?.machine ?? null;
    this.sourceAddress = props()?.source ?? null;
    this.agent = props()?.agent === "claude" ? "claude" : "codex";
    this.sessions = []; this.selectedSession = null; this.loadingHistory = false;
    this.busy = false; this.error = ""; this.states = {};
    this.folder = InputState.new({ value: props()?.folder ?? panes().find(p => p.focused)?.cwd ?? space?.folder ?? "", placeholder: tr("Working folder") });
    this.task = TextareaState.new({ value: this.sourceAddress ? tr("Continue the existing task from this conversation, preserving its instructions and restrictions. Verify what is already complete before doing more work.") : "", placeholder: tr("Describe the complete task and how to verify it."), rows: 5 });
    this.exceptions = TextareaState.new({ value: (shared("unattended.exceptions") ?? []).join("\n"), placeholder: tr("For example: git push\nOne request keyword per line"), rows: 2 });
    this.task.on("change", (_e, cx) => cx.notify());
    this.folder.on("change", (_e, cx) => { this.sessions = []; this.selectedSession = null; cx.notify(); });
    if (this.sourceAddress) this.loadHistory(cx);
    this.refresh(cx);
    cx.timer.every(5000, cx => this.refresh(cx));
  }
  entries() { return shared(HISTORY) ?? []; }
  loadHistory(cx) {
    if (this.loadingHistory || this.busy) return;
    this.loadingHistory = true; this.error = ""; this.selectedSession = null;
    const cwd = this.folder.value();
    cx.spawn(async cx => {
      try {
        if (!this.original) this.original = await originalTerminal(this.sourceAddress, this.on);
        const sessions = await history({ agent: this.agent, cwd, on: this.on });
        if (cwd === this.folder.value()) this.sessions = sessions;
      } catch (error) { this.error = String(error); }
      finally { this.loadingHistory = false; cx.notify(); }
    });
  }
  refresh(cx) {
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async cx => {
      try {
        for (const entry of this.entries()) {
          try {
            const value = await readTextFile(`${entry.directory}/state.json`, { on: entry.on });
            this.states[entry.id] = value ? JSON.parse(value) : null;
          } catch (error) { this.states[entry.id] = { status: "error", error: String(error) }; }
        }
      } finally { this.refreshing = false; cx.notify(); }
    });
  }
  start(cx) {
    if (this.busy || !this.task.value().trim() || (this.sourceAddress && !this.selectedSession)) return;
    this.busy = true; this.error = "";
    const exceptions = this.exceptions.value().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const config = { agent: this.agent, task: this.task.value(), cwd: this.folder.value(), exceptions, on: this.on };
    if (this.sourceAddress) config.resumeSessionId = this.selectedSession;
    cx.spawn(async cx => {
      try {
        if (this.sourceAddress) {
          if (!this.original) throw new Error("Original terminal is unavailable");
          config.source = this.original;
        }
        const entry = await prepare(config);
        run("tab.new", { space: this.space, name: `${entry.agent} · ${tr("Automatic approval")}`, folder: config.cwd || undefined, argv: entry.argv });
        setShared(HISTORY, [entry, ...this.entries()].slice(0, 20));
        setShared("unattended.exceptions", exceptions);
      } catch (error) { this.error = String(error); }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
  }
  toggle(entry, enabled, cx) {
    cx.spawn(async cx => {
      try { await changePolicy(entry, enabled); this.refresh(cx); }
      catch (error) { this.error = String(error); }
      cx.notify();
    });
  }
  button(id, label, action, primary = false, enabled = true) {
    const t = theme();
    return h_flex().id(id).h(32).px(12).items_center().rounded(7).cursor_pointer()
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .opacity(enabled ? 1 : 0.45).hover(s => s.opacity(enabled ? 0.85 : 0.45)).on_click((_e, cx) => { if (enabled) action(cx); }).child(label);
  }
  render() {
    const t = theme();
    const label = text => div().text_size(12).font_medium().text_color(t.dim).child(tr(text));
    const input = element => element.px(10).py(8).rounded(8).bg(t.background).border_1().border_color(t.input).text_color(t.foreground).text_size(13);
    return v_flex().id("unattended").size_full().min_h(0).overflow_y_scrollbar().p(24).gap(14).bg(t.chrome).text_color(t.foreground).text_size(13)
      .child(div().text_size(22).font_semibold().child(tr("Unattended agents")))
      .child(div().text_color(t.dim).child(tr("Approvals default to Yes. Explicit exceptions take priority. Every automatic decision is recorded.")))
      .child(h_flex().gap(8)
        .child(this.button("unattended-codex", "Codex", cx => { this.agent = "codex"; cx.notify(); }, this.agent === "codex", !this.sourceAddress && !this.busy))
        .child(this.button("unattended-claude", "Claude Code", cx => { this.agent = "claude"; cx.notify(); }, this.agent === "claude", !this.sourceAddress && !this.busy))
        .child(div().flex_1()).child(div().text_color(t.dim).child(this.on ?? tr("This computer"))))
      .child(label("Working folder"))
      .child(input(Input.new(this.folder)).h(36))
      .when(Boolean(this.sourceAddress), el => el
        .child(label("Continue an existing conversation"))
        .child(div().text_color(t.dim).child(tr("Select the conversation used by the original terminal. Switching ends that terminal and resumes its saved history here. Wait until its current turn finishes; a pending approval can be resumed.")))
        .child(div().text_size(11).text_color(t.dim).child(`${tr("Original terminal")}: ${this.sourceAddress}`))
        .child(this.button("unattended-history", tr(this.loadingHistory ? "Loading conversations…" : "Refresh conversations"), cx => this.loadHistory(cx), false, !this.loadingHistory && !this.busy))
        .when(!this.loadingHistory && this.sessions.length === 0, el => el.child(div().text_color(t.dim).child(tr("No saved conversations in this folder."))))
        .child(v_flex().id("unattended-sessions").max_h(200).overflow_y_scrollbar().gap(4).children(this.sessions.map(session =>
          v_flex().id(`session-${session.id}`).p(8).gap(3).rounded(6).cursor_pointer().bg(this.selectedSession === session.id ? t.selected : t.surface)
            .on_click((_e, cx) => { if (!this.busy) { this.selectedSession = session.id; cx.notify(); } })
            .child(div().truncate().child(session.title.slice(0, 180)))
            .child(div().text_size(10).text_color(t.dim).child(`${session.id} · ${new Date(session.updated).toLocaleString()}`))))))
      .child(label("Task"))
      .child(input(Textarea.new(this.task)).h(140))
      .child(label("Exceptions to automatic approval"))
      .child(input(Textarea.new(this.exceptions)).h(64))
      .child(div().text_size(11).text_color(t.dim).child(tr("Keywords match request contents without case sensitivity. Matching requests wait for you. You can add exceptions later with /except.")))
      .child(this.button("unattended-start", tr(this.busy ? "Starting…" : this.sourceAddress ? "Switch and continue with automatic approval" : "Start with automatic approval"), cx => this.start(cx), true, !this.busy && Boolean(this.task.value().trim()) && (!this.sourceAddress || Boolean(this.selectedSession))))
      .child(div().text_size(11).text_color(t.dim).child(tr("Runs in its own interactive terminal. Closing the Herdr window keeps it running. Type /auto off to stop automatic approval.")))
      .when(Boolean(this.error), el => el.child(div().text_color(t.destructive).child(this.error)))
      .child(div().h(1).bg(t.border).my(4))
      .child(label("Recent unattended tasks"))
      .when(this.entries().length === 0, el => el.child(div().text_color(t.dim).child(tr("No unattended tasks yet."))))
      .children(this.entries().map(entry => {
        const state = this.states[entry.id];
        const stale = state?.updated && Date.now() - state.updated > 15000;
        const address = state?.terminal ? (entry.on ? `${entry.on}/${state.terminal}` : state.terminal) : null;
        return v_flex().id(`run-${entry.id}`).p(12).gap(8).rounded(8).bg(t.surface)
          .child(h_flex().gap(8).items_center().child(div().font_medium().child(entry.agent))
            .child(div().text_color(t.dim).child(tr(stale && state?.status !== "done" ? "Not connected" : STATUS[state?.status] ?? "Starting…")))
            .child(div().flex_1()).child(div().text_size(11).text_color(t.dim).child(tr("{0} automatic approvals", [state?.approvalCount ?? 0]))))
          .child(div().truncate().child(entry.task))
          .when(Boolean(state?.error), el => el.child(div().text_color(t.destructive).child(state.error)))
          .child(h_flex().gap(8)
            .child(this.button(`open-${entry.id}`, tr("Open terminal"), () => run("terminal.peek", { terminal: address }), false, Boolean(address)))
            .child(this.button(`auto-${entry.id}`, tr(state?.enabled ? "Turn automatic approval off" : "Turn automatic approval on"), cx => this.toggle(entry, !state?.enabled, cx), false, Boolean(state) && state.running !== false && !stale)))
          .child(div().text_size(10.5).text_color(t.dim).child(`${tr("Approval log")}: ${entry.directory}/events.jsonl`));
      }));
  }
}
