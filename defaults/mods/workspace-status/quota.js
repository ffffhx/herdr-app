import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { tr, focused, panes, agents, spaces, exec } from "herdr";

export function quotaTarget(focus, paneList, agentList, spaceList) {
  if (!focus?.terminal) return null;
  const terminal = focus.shown || focus.terminal;
  const agent = agentList.find(a => a.address === terminal);
  const pane = paneList.find(p => p.terminal === terminal);
  const program = agent?.app || pane?.app || agent?.program?.key || pane?.program?.key;
  const provider = /^(codex|codex-cli)$/.test(program || "") ? "codex" : /^(claude|claude-code)$/.test(program || "") ? "claude" : null;
  if (!provider) return null;
  const remote = Boolean(spaceList.find(s => s.id === focus.space)?.machine || terminal.includes("/"));
  return { provider, remote, key: `${remote ? "remote" : "local"}:${provider}` };
}

const current = () => quotaTarget(focused(), panes(), agents(), spaces());
const money = (currency, value) => (currency === "CNY" ? "¥" : "US$") + Number(value).toFixed(2);
export function windowLabel(minutes) {
  if (minutes === 10080) return tr("Weekly");
  if (minutes % 1440 === 0) return tr("{0}d", [String(minutes / 1440)]);
  if (minutes % 60 === 0) return tr("{0}h", [String(minutes / 60)]);
  return tr("{0}m", [String(minutes)]);
}

export class Quota {
  constructor(loadProbe) { this.cache = {}; this.pending = new Set(); this.loadProbe = loadProbe; }

  refresh(cx, force = false) {
    const target = current();
    if (!target || target.remote || this.pending.has(target.key)) return;
    const prior = this.cache[target.key], now = Date.now();
    const delay = prior?.status === "rate-limited" ? 120000 : 30000;
    if (!force && prior && now - prior.attemptedAt < delay) return;
    this.pending.add(target.key);
    // A mod clone keeps its probe alongside its main.js, so it survives app
    // updates. Pass source as a single argv value; never as shell source.
    cx.spawn(async (cx) => {
      try {
        if (!this.probe) this.probe = await this.loadProbe();
        if (!this.probe) throw new Error("missing probe");
        const result = await exec("node", ["-e", this.probe, target.provider]);
        const value = result.code === 0 ? JSON.parse(result.stdout) : { status: "unavailable", windows: [] };
        if (!Array.isArray(value.windows)) throw new Error("invalid reply");
        this.cache[target.key] = { ...value, attemptedAt: Date.now() };
      } catch {
        this.cache[target.key] = { status: "unavailable", windows: [], attemptedAt: Date.now() };
      } finally { this.pending.delete(target.key); cx.notify(); }
    });
  }

  render(cx, t) {
    const target = current();
    if (!target) return null;
    this.refresh(cx);
    const data = this.cache[target.key];
    const pending = this.pending.has(target.key);
    const status = target.remote ? "remote" : data?.status || "loading";
    const balance = data?.provider === "deepseek";
    const name = balance ? "DeepSeek" : target.provider === "codex" ? "Codex" : "Claude";
    const messages = {
      loading: tr("Checking quota…"), remote: tr("Remote quota unavailable"),
      "sign-in": tr("Sign in to check quota"), "missing-cli": tr("Agent CLI not found"),
      "rate-limited": tr("Quota check rate limited"), timeout: tr("Quota check timed out"),
      unavailable: tr("Quota unavailable"), unsupported: tr("Quota unavailable"),
      "api-key-missing": tr("API key not configured"), "api-key-invalid": tr("API key invalid or expired"),
      "api-unsupported": tr("Balance unavailable for this API provider"),
    };
    if (balance) Object.assign(messages, {
      unavailable: tr("Balance unavailable"), "rate-limited": tr("Balance check rate limited"), timeout: tr("Balance check timed out"),
    });
    const stale = data?.updatedAt && Date.now() - data.updatedAt > 90000;
    let tooltip = balance
      ? tr("DeepSeek API account balance from this computer's Claude configuration. Refreshes every 30 seconds. Click to refresh.")
      : tr("Account quota from this computer's Agent login. Refreshes every 30 seconds. Click to refresh.");
    if (data?.updatedAt) tooltip += "\n" + tr("Updated: {0}", [new Date(data.updatedAt).toLocaleTimeString()]);
    for (const w of data?.windows || []) {
      if (w.resetsAt) tooltip += "\n" + tr("{0} resets: {1}", [windowLabel(w.minutes), new Date(w.resetsAt).toLocaleString()]);
    }
    for (const b of data?.balances || []) {
      if (b.toppedUp !== null) tooltip += "\n" + tr("Top-up balance: {0}", [money(b.currency, b.toppedUp)]);
      if (b.granted !== null) tooltip += "\n" + tr("Granted balance: {0}", [money(b.currency, b.granted)]);
    }
    if (balance && status === "ok" && !data.available) tooltip += "\n" + tr("No balance available for API calls");
    if (status !== "ok") tooltip += "\n" + (messages[status] || messages.unavailable);
    if (status === "unavailable" && !balance) tooltip += "\n" + tr("Requires Node.js and a subscription login; API-key billing may not report quota.");
    const row = h_flex().id("agent-quota").gap(7).items_center().flex_none().px(6).rounded(4)
      .hover(s => s.bg(t.hover)).tooltip(tooltip)
      .on_click((_event, cx) => { this.refresh(cx, true); cx.notify(); })
      .child(div().text_color(t.dim).child(name));
    if (status === "ok") {
      for (const b of data.balances || []) {
        row.child(div().text_color(stale ? t.dim : !data.available || Number(b.total) <= 0 ? t.blocked : t.muted)
          .child(tr("Balance {0}", [money(b.currency, b.total)])));
      }
      for (const w of data.windows) {
        const remaining = Math.floor(w.remaining);
        row.child(div().text_color(stale ? t.dim : remaining <= 20 ? t.blocked : t.muted)
          .child(tr("{0} {1}% left", [windowLabel(w.minutes), String(remaining)])));
      }
      if (stale) row.child(tr("Stale"));
    } else row.child(div().text_color(t.dim).child(messages[status] || messages.unavailable));
    if (pending && status !== "loading") row.child("↻");
    return row;
  }
}
