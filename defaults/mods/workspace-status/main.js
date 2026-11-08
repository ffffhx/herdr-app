import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { tr, spaces, agents, theme, run, window, keys, readTextFile, appHome } from "herdr";
import { Quota } from "./quota.js";

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    this.quota = new Quota(async () => {
      // import.meta.url identifies this mod even when it is a personal clone.
      const source = String(import.meta.url);
      const directory = source.slice(0, source.lastIndexOf("/"));
      try {
        const folder = decodeURIComponent(directory.replace(/^file:\/\//, "")).replace(/^\/([A-Za-z]:\/)/, "$1");
        const probe = await readTextFile(folder + "/quota-probe.cjs");
        if (probe) return probe;
      } catch { /* A packaged mod may report a relative module name. */ }
      return readTextFile(appHome() + "/mods/workspace-status/quota-probe.cjs");
    });
    cx.timer.every(30000, (cx) => this.quota.refresh(cx));
  }
  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? tr("{0}  commands", [key]) : "commands";
  }

  render(cx) {
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? tr("This computer")))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(tr("{0} agents", [list.length]))
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(tr("· {0} needs you", [String(needs)])))))
      .child(div().flex_1())
      .child(div().id("session-recovery").text_color(t.dim).cursor_pointer().on_click(() => run("tab.new", { mod: "recovery", name: tr("Session recovery") })).child(tr("Session recovery")))
      .when(Boolean(this.quota), el => { const quota = this.quota.render(cx, t); return quota ? el.child(quota) : el; })
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t)));
  }
}
