import { View, div } from "gpui-kit";
import { h_flex, v_flex, Input, InputState } from "gpui-base";
import { tr, theme, spaces, panes, props, appHome, shared, setShared, exec, openOverlay, closeOverlay } from "herdr";

const PROFILES_KEY = "antigravity.profiles";
const PRESETS = ["Pro", "Ultra"];

export default class AntigravityProfiles extends View {
  init(_props, cx) {
    this.profiles = this.savedProfiles();
    this.statusById = {};
    this.busy = false;
    this.confirmRemove = null;
    this.error = "";
    this.name = InputState.new({ value: "", placeholder: tr("e.g. Pro, Ultra, Work") });
    this.name.on("change", (_e, cx) => cx.notify());
    this.refresh(cx);
  }

  savedProfiles() {
    const list = shared(PROFILES_KEY);
    return Array.isArray(list) ? list.filter(p => p && typeof p.id === "string" && typeof p.name === "string") : [];
  }

  runner() {
    return `${appHome()}/mods/antigravity-profiles/runner.mjs`;
  }

  refresh(cx) {
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async cx => {
      try {
        const res = await exec("node", [this.runner(), "--list", "--home", appHome()]);
        if (res.code === 0 && res.stdout.trim()) {
          const data = JSON.parse(res.stdout);
          const list = Array.isArray(data.profiles) ? data.profiles : [];
          this.statusById = Object.fromEntries(list.map(p => [p.id, p]));
          const compact = list.map(({ id, name, createdAt }) => ({ id, name, ...(createdAt ? { createdAt } : {}) }));
          this.profiles = compact;
          setShared(PROFILES_KEY, compact);
        }
      } catch {
        // Keep cached profiles when the helper is unavailable (e.g. initial preview).
      } finally {
        this.refreshing = false;
        cx.notify();
      }
    });
  }

  launchProfile(profile) {
    const space = spaces().find(s => s.id === props()?.space) ?? spaces().find(s => s.active && !s.machine) ?? spaces().find(s => !s.machine);
    const folder = props()?.folder
      || panes().find(p => p.focused && space?.tabs?.some(tab => tab.id === p.tab))?.cwd
      || space?.folder;
    if (props()?.overlay) closeOverlay(props().overlay);
    openOverlay({
      mod: "unattended",
      kind: "dialog",
      width: 420,
      height: 200,
      props: {
        space: space?.id,
        agent: "antigravity",
        launch: ["agy"],
        name: `Antigravity · ${profile.name}`,
        profile: { id: profile.id, name: profile.name },
        folder,
      },
    });
  }

  addAccount(rawName, andLaunch, cx) {
    const label = String(rawName ?? this.name.value()).trim();
    if (!label || this.busy) return;
    this.busy = true;
    this.error = "";
    this.confirmRemove = null;
    cx.spawn(async cx => {
      try {
        const res = await exec("node", [this.runner(), "--add", "--name", label, "--home", appHome()]);
        if (res.code !== 0) throw new Error(res.stderr.trim() || tr("Could not create account profile"));
        const data = JSON.parse(res.stdout);
        const list = Array.isArray(data.profiles) ? data.profiles : [];
        this.statusById = Object.fromEntries(list.map(p => [p.id, p]));
        const compact = list.map(({ id, name, createdAt }) => ({ id, name, ...(createdAt ? { createdAt } : {}) }));
        this.profiles = compact;
        setShared(PROFILES_KEY, compact);
        this.name = InputState.new({ value: "", placeholder: tr("e.g. Pro, Ultra, Work") });
        this.name.on("change", (_e, cx) => cx.notify());
        if (andLaunch && data.profile) this.launchProfile(data.profile);
      } catch (error) {
        this.error = String(error?.message || error);
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }

  removeAccount(id, cx) {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    this.confirmRemove = null;
    cx.spawn(async cx => {
      try {
        const res = await exec("node", [this.runner(), "--remove", "--profile", id, "--home", appHome()]);
        if (res.code !== 0) throw new Error(res.stderr.trim() || tr("Could not remove account profile"));
        const data = JSON.parse(res.stdout);
        const list = Array.isArray(data.profiles) ? data.profiles : [];
        this.statusById = Object.fromEntries(list.map(p => [p.id, p]));
        const compact = list.map(({ id: pid, name, createdAt }) => ({ id: pid, name, ...(createdAt ? { createdAt } : {}) }));
        this.profiles = compact;
        setShared(PROFILES_KEY, compact);
      } catch (error) {
        this.error = String(error?.message || error);
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }

  button(id, label, action, primary = false, enabled = true) {
    const t = theme();
    return h_flex().id(id).h(32).px(12).items_center().rounded(7).cursor_pointer()
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .opacity(enabled ? 1 : 0.45).hover(s => s.opacity(enabled ? 0.85 : 0.45))
      .on_click((_e, cx) => { if (enabled) action(cx); }).child(label);
  }

  render(cx) {
    const t = theme();
    const existingNames = new Set(this.profiles.map(p => p.name.toLowerCase()));
    const availablePresets = PRESETS.filter(p => !existingNames.has(p.toLowerCase()));
    return v_flex().id("antigravity-profiles").size_full().min_h(0).overflow_y_scrollbar()
      .p(24).gap(14).bg(t.chrome).text_color(t.foreground).text_size(13)
      .child(h_flex().items_center().gap(10)
        .child(div().text_size(22).font_semibold().child(tr("Antigravity accounts")))
        .child(div().flex_1())
        .child(this.button("agy-profiles-refresh", tr("Refresh"), cx => this.refresh(cx), false, !this.busy)))
      .child(div().text_color(t.dim).child(tr("Run multiple Google AI accounts side by side in native Antigravity terminals. Each account stores its OAuth token in an isolated profile directory instead of macOS Keychain while sharing your repositories, git and SSH setup.")))
      .child(v_flex().p(14).gap(10).rounded(8).bg(t.surface)
        .child(div().text_size(12).font_medium().text_color(t.dim).child(tr("Add isolated account")))
        .child(h_flex().gap(8).items_center()
          .child(Input.new(this.name).flex_1().h(36).px(10).py(8).rounded(8).bg(t.background).border_1().border_color(t.input).text_color(t.foreground).text_size(13))
          .child(this.button("agy-profile-add-launch", tr("Add & sign in"), cx => this.addAccount(null, true, cx), true, !this.busy && Boolean(this.name.value().trim())))
          .child(this.button("agy-profile-add", tr("Add"), cx => this.addAccount(null, false, cx), false, !this.busy && Boolean(this.name.value().trim()))))
        .when(availablePresets.length > 0, el => el.child(h_flex().gap(8).items_center()
          .child(div().text_size(11.5).text_color(t.dim).child(tr("Quick add:")))
          .children(availablePresets.map(preset =>
            this.button(`agy-preset-${preset.toLowerCase()}`, `+ ${preset}`, cx => this.addAccount(preset, false, cx), false, !this.busy))))))
      .when(Boolean(this.error), el => el.child(div().text_color(t.blocked).child(this.error)))
      .child(div().text_size(12).font_medium().text_color(t.dim).child(tr("Configured accounts")))
      .when(this.profiles.length === 0, el => el.child(div().p(14).rounded(8).bg(t.surface).text_color(t.dim)
        .child(tr("No isolated accounts yet. Add accounts such as Pro and Ultra above; they will appear in the + menu immediately."))))
      .children(this.profiles.map(profile => {
        const detail = this.statusById[profile.id];
        const signedIn = detail?.signedIn === true;
        const confirming = this.confirmRemove === profile.id;
        return v_flex().id(`agy-profile-${profile.id}`).p(14).gap(8).rounded(8).bg(t.surface)
          .child(h_flex().gap(10).items_center()
            .child(div().font_semibold().child(`Antigravity · ${profile.name}`))
            .child(div().px(6).py(2).rounded(4).text_size(11).bg(t.raised)
              .text_color(detail ? (signedIn ? t.foreground : t.dim) : t.dim)
              .child(detail ? tr(signedIn ? "Signed in" : "Not signed in") : profile.id))
            .child(div().flex_1())
            .child(this.button(`agy-start-${profile.id}`, tr(signedIn ? "Start" : "Start & sign in"), () => this.launchProfile(profile), true, !this.busy))
            .when(!confirming, el => el.child(this.button(`agy-remove-${profile.id}`, tr("Remove"), cx => { this.confirmRemove = profile.id; cx.notify(); }, false, !this.busy)))
            .when(confirming, el => el.child(h_flex().gap(6)
              .child(this.button(`agy-confirm-remove-${profile.id}`, tr("Confirm remove"), cx => this.removeAccount(profile.id, cx), false, !this.busy))
              .child(this.button(`agy-cancel-remove-${profile.id}`, tr("Cancel"), cx => { this.confirmRemove = null; cx.notify(); }, false, !this.busy)))))
          .child(div().text_size(11).text_color(t.dim).child(`${tr("Profile ID")}: ${profile.id} · ${appHome()}/data/antigravity-profiles/${profile.id}/home/.gemini`));
      }));
  }
}
