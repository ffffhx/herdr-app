import { tr } from "herdr";

// Personal mod copies can be hot-loaded into an older installed app, whose
// compiled translation catalog does not yet contain these new messages.
const chinese = {
  "Claude Official": "Claude 官方",
  "Waiting for usage update": "等待用量更新",
  "Usage expired; waiting for update": "用量已过期，等待更新",
  "Session provider not identified": "尚未识别会话服务",
  "Usage received locally from this Claude Code session. Click to reread local data; no account request is sent. Start a new official session to enable collection if needed.": "读取此 Claude Code 会话提供的本地用量。点击只会重读本地数据，不会查询账户。未接入采集的旧会话需要重新从官方入口启动。",
  "Usage received locally from this Antigravity session. Click to reread local data; no account request is sent. Start or resume a session to enable collection if needed.": "读取此 Antigravity 会话提供的本地用量。点击只会重读本地数据，不会查询账户。未接入采集的旧会话重新启动或恢复对话后生效。",
  "DeepSeek API balance for this session's launcher. Refreshes every 30 seconds. Click to refresh.": "此会话启动器对应的 DeepSeek API 余额，每 30 秒自动刷新。点击立即刷新。",
  "Use an explicit Claude launcher to identify this session. No Claude account request is sent.": "请使用明确的 Claude 启动入口以识别会话服务。不会发送 Claude 账户查询请求。",
};
export function usageText(source) {
  const translated = tr(source);
  return translated !== source ? translated : tr("Weekly") === "每周" ? chinese[source] || source : source;
}
