// Context menus (Herdr's items). Opened as a popup with
// props { tab: "pane" | "tab" | "space" | "global", target }.
// ↑/↓ move, Enter runs, Esc closes. An item is [label, command, args];
// a command "worktree" opens the worktree dialog instead.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { tr, run, props, closeOverlay, openOverlay, theme, keys, terminals, spaces, panes, exec } from "herdr";

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

// A space's checkout: "main" (a repo's own), "linked" (a worktree), or null.
async function checkout(folder, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on });
  const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder, on });
  if (top.code !== 0 || common.code !== 0) return null;
  return common.stdout.trim() === `${top.stdout.trim()}/.git` ? "main" : "linked";
}

function unattendedItem(term, pane, spaceId) {
  const app = term?.report?.app;
  const agent = app === "codex" ? "codex" : ["claude", "claude-code"].includes(app) ? "claude" : null;
  const managed = !term?.labels?.["herdr.unattended.control"] && term?.argv?.some(a => a.endsWith("/unattended/runner.mjs") || a.endsWith("\\unattended\\runner.mjs") || a.endsWith("/runner.mjs"));
  if (!agent || managed) return null;
  const space = spaceId ?? spaces().find(s => s.tabs?.some(t => t.id === pane?.tab))?.id;
  const enabled = term?.labels?.["herdr.unattended"] === "on";
  return [tr(enabled ? "Turn automatic approval off" : "Switch to unattended"), "tab.new", { space, mod: "unattended", props: { space, source: term.address, sourceCreated: term.created_ms, sourcePane: pane?.pane, agent, ...(enabled ? { disable: true } : {}) } }];
}

function items(p, git) {
  p = p ?? {};
  const tg = p.target ?? {};
  switch (p.tab) {
    case "pane": {
      // A kept sub-agent can go back under its parent, still running.
      const all = terminals();
      const term = all.find((t) => t.address === tg.terminal);
      const parent = term?.parent && all.find((t) => t.address === term.parent);
      // Once they go to the program, Shift+right-click still opens this menu.
      const toProgram = term?.labels?.["herdr.right-click"] === "program";
      const pane = panes().find(p => p.pane === tg.pane);
      const unattended = unattendedItem(term, pane);
      return [
        ...(unattended ? [unattended] : []),
        [tr("Session recovery"), "tab.new", { mod: "recovery", name: tr("Session recovery"), props: { terminal: tg.terminal } }],
        [tr("Split right"), "pane.split", { direction: "right", pane: tg.pane }],
        [tr("Split down"), "pane.split", { direction: "down", pane: tg.pane }],
        [tr("Zoom"), "pane.zoom", { pane: tg.pane }],
        ...(term
          ? [
              toProgram
                ? [tr("Use Herdr right-click menu"), "terminal.right_click", { terminal: term.address, to: "menu" }]
                : [tr("Send right-clicks to pane"), "terminal.right_click", { terminal: term.address, to: "program" }],
            ]
          : []),
        ...(parent ? [[tr("Send back to {0}", [String(parent.name || parent.address)]), "terminal.park", { terminal: term.address }]] : []),
        [tr("Close pane"), "pane.close", { pane: tg.pane }],
      ];
    }
    case "tab": {
      // Use the clicked tab, including inactive tabs. A split tab offers each
      // eligible terminal explicitly instead of guessing the focused agent.
      const all = terminals();
      const unattended = panes().filter(pane => pane.tab === tg.id)
        .map(pane => unattendedItem(all.find(t => t.address === pane.terminal), pane, tg.space))
        .filter(Boolean);
      if (unattended.length > 1) for (const item of unattended) item[0] += ` · ${item[2].props.source}`;
      return [
        ...unattended,
        [tr("Session recovery"), "tab.new", { space: tg.space, mod: "recovery", name: tr("Session recovery") }],
        [tr("Rename"), "tab.rename", { id: tg.id }],
        [tr("New tab"), "tab.new", { space: tg.space }],
        [tr("Close"), "tab.close", { id: tg.id }],
      ];
    }
    case "space":
      return [
        [tr("Rename"), "space.rename", { id: tg.id }],
        ...(git ? [[tr("New worktree"), "worktree", { space: tg.id, action: "new" }], [tr("Open worktree"), "worktree", { space: tg.id, action: "open" }]] : []),
        ...(git === "linked" ? [[tr("Remove worktree"), "worktree", { space: tg.id, action: "remove" }]] : []),
        [tr("Close"), "space.close", { id: tg.id }],
      ];
    default:
      return [
        [tr("Session recovery"), "mod.open", { name: "recovery" }],
        [tr("New space"), "space.new", {}],
        [tr("Keybinds"), "app.help", {}],
        [tr("Theme: graphite"), "app.theme", { name: "graphite" }],
        [tr("Theme: ink"), "app.theme", { name: "ink" }],
        [tr("Theme: moss"), "app.theme", { name: "moss" }],
        [tr("Theme: atom one dark"), "app.theme", { name: "atom-one-dark" }],
      ];
  }
}

function menuIcon(command) {
  const name = command.endsWith(".close") ? "x" : command.endsWith(".rename") ? "square-pen" : command.endsWith(".new") ? "plus" : command === "worktree" ? "git-branch" : command === "app.help" ? "terminal" : command === "app.theme" ? "settings" : command === "pane.split" ? "panel-right" : command === "pane.zoom" ? "square" : "terminal";
  return `mods/workspace-chrome/${name}.svg`;
}

// The key bound to a command, for the hint on the right.
function shortcut(name, args) {
  // `pane.split:right` binds pane.split with { direction: "right" }.
  const value = args && Object.values(args)[0];
  const k = keys().find((b) => b.section === "global" && (b.action === name || b.action === `${name}:${value}`));
  return k ? k.keys : "";
}

export default class Menu extends View {
  init(_props, cx) {
    this.at = 0;
    this.git = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    const p = props();
    const space = p?.tab === "space" && spaces().find((s) => s.id === p.target?.id);
    const folder = space && place(space);
    if (folder)
      cx.spawn(async (cx) => {
        this.git = await checkout(folder, space.machine).catch(() => null);
        cx.notify();
      });
  }

  choose(i, cx) {
    const it = items(props(), this.git)[i];
    if (!it) return;
    closeOverlay(props()?.overlay);
    if (it[1] === "worktree") openOverlay({ mod: "worktree", kind: "dialog", ...(it[2].action === "open" ? { width: 560, height: 480 } : { width: 440, height: 260 }), props: it[2] });
    else if (it[2]?.mod === "unattended") openOverlay({ mod: "unattended", kind: "dialog", width: 490, height: 260, props: it[2].props });
    else run(it[1], it[2]);
  }

  render(cx) {
    const t = theme();
    const list = items(props(), this.git);
    return v_flex()
      .id("menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at, cx);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(
        list.map((it, i) =>
          v_flex()
            .when(i > 0 && (it[1].endsWith(".close") || it[1] === "app.help" || (it[1] === "app.theme" && list[i - 1][1] !== "app.theme")), el => el.child(div().mx(7).my(4).h(1).bg(t.border)))
            .child(h_flex()
            .id(`mi-${i}`)
            .h(31)
            .px(8)
            .gap(9)
            .rounded(7)
            .items_center()
            .justify_between()
            .text_color(t.foreground)
            .when(i === this.at, (el) => el.bg(t.selected))
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.choose(i, cx))
            .child(svg(menuIcon(it[1])).size(14).flex_none().text_color(t.muted))
            .child(div().flex_1().child(it[0]))
            .child(div().text_size(11).text_color(t.dim).child(shortcut(it[1], it[2])))),
        ),
      );
  }
}
