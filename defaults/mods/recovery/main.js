import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { tr, theme, appHome, readTextFile, exec, run, props } from "herdr";

const STATES = { ready: "Conversation saved", restoring: "Restoring conversation", failed: "Recovery failed", closed: "Session ended", pending: "Waiting to restore" };
export default class Recovery extends View {
  init(_props, cx) { this.rows = []; this.integrations = []; this.error = ""; this.refresh(cx); cx.timer.every(5000, cx => this.refresh(cx)); }
  refresh(cx) {
    if (this.reading) return;
    this.reading = true;
    cx.spawn(async cx => {
      try {
        const value = await readTextFile(`${appHome()}/data/recovery/status.json`);
        if (value) { const state = JSON.parse(value); this.enabled = state.enabled !== false; this.rows = state.records || []; this.integrations = state.integrations || []; this.error = Date.now() - state.updated > 20000 ? tr("Recovery service is not connected") : ""; }
        else this.error = tr("Recovery service is starting");
        const error = await readTextFile(`${appHome()}/data/recovery/error.json`);
        if (error && (!value || JSON.parse(error).updated > JSON.parse(value).updated)) this.error = JSON.parse(error).error;
      } catch (error) { this.error = String(error); }
      finally { this.reading = false; cx.notify(); }
    });
  }
  retry(row, cx) {
    if (this.busy) return;
    this.busy = row.key;
    cx.spawn(async cx => {
      try {
        const result = await exec("node", [`${appHome()}/mods/recovery/service.mjs`, "retry", appHome(), row.key]);
        if (result.code !== 0) throw new Error(result.stderr);
        this.refresh(cx);
      } catch (error) { this.error = String(error); }
      finally { this.busy = null; cx.notify(); }
    });
  }
  toggle(cx) {
    if (this.busy) return;
    this.busy = "setting";
    cx.spawn(async cx => {
      try {
        const result = await exec("node", [`${appHome()}/mods/recovery/service.mjs`, this.enabled ? "disable" : "enable", appHome()]);
        if (result.code !== 0) throw new Error(result.stderr);
        this.enabled = !this.enabled;
      } catch (error) { this.error = String(error); }
      finally { this.busy = null; cx.notify(); }
    });
  }
  render(cx) {
    const t = theme(), target = props()?.terminal;
    const rows = this.rows.filter(r => !target || r.terminal === target);
    return v_flex().size_full().p(24).gap(14).bg(t.background).text_color(t.foreground).overflow_y_scroll()
      .child(div().text_size(22).font_semibold().child(tr("Session recovery")))
      .child(div().text_size(13).text_color(t.muted).child(tr("Saved conversations reopen in their original terminals after a restart. No new task is sent.")))
      .child(div().id("recovery-toggle").cursor_pointer().text_color(t.accent).on_click((_event, cx) => this.toggle(cx)).child(tr(this.enabled === false ? "Enable automatic recovery" : "Disable automatic recovery")))
      .child(div().text_size(12).text_color(t.muted).child(tr("Allow Herdr's session hook when the agent asks. Existing sessions need to load the hook before their identity can be saved.")))
      .when(Boolean(this.error), el => el.child(div().text_color(t.blocked).child(this.error)))
      .children(this.integrations.map(i => div().text_size(12).text_color(i.state === "error" ? t.blocked : t.muted).child(`${i.agent}: ${i.state === "installed" ? tr("Session capture installed") : i.error || tr("Agent not installed")}`)))
      .when(!rows.length, el => el.child(div().py(20).text_color(t.muted).child(tr("No conversation captured yet. Start or resume Codex or Claude Code in Herdr to save its identity."))))
      .children(rows.map(row => v_flex().p(14).gap(6).rounded(8).border(1).border_color(t.border)
        .child(h_flex().gap(12).child(div().font_semibold().child(`${row.agent} · ${row.terminal}`)).child(div().text_color(t.muted).child(tr(STATES[row.state] || "Conversation saved"))))
        .child(div().text_size(12).text_color(t.dim).child(row.cwd))
        .child(div().text_size(12).text_color(t.dim).child(row.sessionId))
        .when(Boolean(row.error), el => el.child(div().text_color(t.blocked).child(row.error)))
        .child(h_flex().gap(12)
          .child(div().id(`recovery-show-${row.terminal}`).cursor_pointer().text_color(t.accent).on_click(() => run("agent.focus", { terminal: row.terminal })).child(tr("Show terminal")))
          .when(row.state === "failed" && row.attempt?.state !== "unknown", el => el.child(div().id(`recovery-retry-${row.terminal}`).cursor_pointer().text_color(t.accent).on_click((_event, cx) => this.retry(row, cx)).child(tr("Retry recovery")))))));
  }
}
