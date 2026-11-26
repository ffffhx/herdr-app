const valueOptions = { "-s": "sandbox", "--sandbox": "sandbox", "-a": "approval", "--ask-for-approval": "approval", "-p": "profile", "--profile": "profile", "-c": "config", "--config": "config" };
const presets = new Set(["--dangerously-bypass-approvals-and-sandbox", "--yolo", "--full-auto", "--approve-for-me"]);
const permissionKey = /^(approval_policy|approvals_reviewer|sandbox_mode|default_permissions|sandbox_workspace_write(?:\..*)?|permissions(?:\..*)?)$/;
const sessionId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

// Only permission options are eligible for replay on recovery. Never replay
// prompts, commands or a previous resume target.
export function codexOptions(args) {
  const selected = { flags: [], custom: false, subcommand: args.length };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--no-daemon") continue;
    if (arg === "resume" || arg === "fork") {
      selected.subcommand = Math.min(selected.subcommand, i);
      if (sessionId.test(args[i + 1])) i++;
      else selected.custom = true;
      continue;
    }
    if (presets.has(arg)) {
      selected.flags.push(arg);
      selected.preset = arg;
      continue;
    }
    const option = /^(--[\w-]+)(?:=(.*))?$/s.exec(arg) ?? /^(-[sacp])(.+)?$/s.exec(arg);
    const kind = option && Object.hasOwn(valueOptions, option[1]) && valueOptions[option[1]];
    if (!kind) { selected.custom = true; continue; }
    const value = option[2] ?? args[++i];
    if (typeof value !== "string") { selected.custom = true; continue; }
    if (kind === "config") {
      const index = value.indexOf("=");
      const key = value.slice(0, index).trim();
      if (index < 0 || !permissionKey.test(key)) { selected.custom = true; continue; }
      const setting = value.slice(index + 1).trim().replace(/^["']|["']$/g, "");
      if (key === "approval_policy") selected.approval = setting;
      if (key === "sandbox_mode") selected.sandbox = setting;
      if (key === "sandbox_workspace_write.network_access") selected.network = setting;
      if (key === "default_permissions" || key.startsWith("permissions.")) selected.profile = key;
    } else selected[kind] = value;
    selected.flags.push(option[1], value);
  }
  return selected;
}

export function codexLaunchArgs(args, enabled = true, exceptions) {
  if (!enabled) return [...args];
  const { flags, custom, subcommand, preset, profile, approval, sandbox, network } = codexOptions(args);
  const guarded = Array.isArray(exceptions) && exceptions.length > 0;
  if (guarded && (preset || profile || (approval && approval !== "on-request") || sandbox === "danger-full-access" || network === "true")) {
    throw new Error("Codex launcher permissions conflict with unattended approval exceptions");
  }
  if (preset || profile) return [...args];
  const extra = [];
  if (!sandbox) extra.push("-s", "workspace-write");
  if (!approval) extra.push("-a", "on-request");
  // Keep exceptional commands on the native approval path. An unknown old
  // descriptor or custom launcher never opts into network on Herdr's behalf.
  if (!custom && flags.length === 0 && Array.isArray(exceptions)) {
    extra.push("-c", `sandbox_workspace_write.network_access=${!guarded}`);
  }
  return [...args.slice(0, subcommand), ...extra, ...args.slice(subcommand)];
}
