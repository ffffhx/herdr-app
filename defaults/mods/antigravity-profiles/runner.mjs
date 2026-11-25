// CLI entrypoint for isolated Antigravity profiles:
// - Management subcommands used by the GPUI mod (--list, --add, --remove, --prepare)
// - Direct isolated launcher (--profile <id> [--name <name>] --home <appHome> -- agy [args...])

import { existsSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  addProfile,
  defaultAppHome,
  labelTerminalProfile,
  listProfilesWithStatus,
  prepareProfile,
  removeProfile,
} from "./profiles.mjs";
import { childEnvironment } from "../unattended/transport.mjs";

export function parseArgs(argv) {
  const sep = argv.indexOf("--");
  const flags = sep >= 0 ? argv.slice(0, sep) : argv;
  const command = sep >= 0 ? argv.slice(sep + 1) : [];
  const opts = {};
  for (let i = 0; i < flags.length; i++) {
    const key = flags[i];
    if (key === "--list" || key === "--add" || key === "--remove" || key === "--prepare") {
      opts.action = key.slice(2);
    } else if (key === "--profile" || key === "--name" || key === "--home") {
      opts[key.slice(2)] = flags[++i];
    }
  }
  return { opts, command };
}

export async function runIsolated(argv, { launch = spawn, platform = process.platform, env = process.env } = {}) {
  const { opts, command } = parseArgs(argv);
  const appHome = opts.home || defaultAppHome(env);

  if (opts.action === "list") {
    return { code: 0, json: { profiles: listProfilesWithStatus(appHome) } };
  }
  if (opts.action === "add") {
    const result = addProfile({ appHome, name: opts.name, id: opts.profile, baseEnv: env, platform });
    return { code: 0, json: { profile: result.profile, profiles: listProfilesWithStatus(appHome) } };
  }
  if (opts.action === "remove") {
    removeProfile({ appHome, id: opts.profile });
    return { code: 0, json: { removed: opts.profile, profiles: listProfilesWithStatus(appHome) } };
  }
  if (opts.action === "prepare") {
    const prepared = prepareProfile({ appHome, id: opts.profile, name: opts.name, baseEnv: env, platform });
    return { code: 0, json: { id: prepared.id, name: prepared.name, home: prepared.paths.home, agyHome: prepared.paths.agyHome } };
  }

  if (!opts.profile) throw new Error("Missing --profile <id>");
  const target = command.length ? command : ["agy"];
  const prepared = prepareProfile({ appHome, id: opts.profile, name: opts.name, baseEnv: env, platform });
  labelTerminalProfile(prepared.id, prepared.name, { env: prepared.env, platform });

  const childEnv = platform === "win32" ? childEnvironment(prepared.env, platform) : prepared.env;
  const keepParent = () => {};
  process.on("SIGINT", keepParent);
  try {
    const code = await new Promise((resolve, reject) => {
      const child = launch(target[0], target.slice(1), {
        env: childEnv,
        stdio: "inherit",
        windowsHide: false,
      });
      child.on("error", reject);
      child.on("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
    });
    return { code };
  } finally {
    process.off("SIGINT", keepParent);
  }
}

const isMain = import.meta.main
  ?? (process.argv[1] && existsSync(process.argv[1]) && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url);

if (isMain) {
  runIsolated(process.argv.slice(2))
    .then(result => {
      if (result.json !== undefined) process.stdout.write(JSON.stringify(result.json) + "\n");
      process.exitCode = result.code ?? 0;
    })
    .catch(error => {
      process.stderr.write(`[Herdr Antigravity profile] ${error.message}\n`);
      process.exitCode = 1;
    });
}
