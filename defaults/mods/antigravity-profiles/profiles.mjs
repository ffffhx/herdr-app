// Isolated multi-account Antigravity CLI (agy) profile manager.
// Uses agy's official AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1 file-based token
// storage with a per-profile shadow HOME whose .gemini directory is isolated
// while sharing the user's repositories, git, SSH, and XDG directories.
// Never reads, logs, or copies OAuth tokens or macOS Keychain credentials.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { install as installRecoveryHooks } from "../recovery/install.mjs";

const require = createRequire(import.meta.url);
const { installStatusLine } = require("../workspace-status/antigravity-usage.cjs");

export const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const PROFILES_SHARED_KEY = "antigravity.profiles";
const MAX_PROFILES = 16;
const MAX_NAME_LEN = 40;
const SKIP_HOME_ENTRIES = new Set([
  ".gemini",
  ".Trash",
  ".DS_Store",
  ".CFUserTextEncoding",
  ".herdr-profile-links.json",
]);
const SHARED_GEMINI_CONFIG_ENTRIES = ["GEMINI.md", "AGENTS.md", "skills", "mcp_config.json"];
const LINK_MANIFEST = ".herdr-profile-links.json";

export function defaultAppHome(env = process.env, userHome = homedir()) {
  return env.HERDR_APP_HOME || join(env.XDG_CONFIG_HOME || join(userHome, ".config"), "herdr-app");
}

export function validateProfileId(id) {
  if (typeof id !== "string" || !PROFILE_ID_RE.test(id)) {
    throw new Error("Invalid Antigravity profile ID");
  }
  return id;
}

export function normalizeProfileName(name) {
  const clean = String(name ?? "").trim().replace(/\s+/g, " ").slice(0, MAX_NAME_LEN);
  if (!clean) throw new Error("Enter an account name");
  return clean;
}

export function slugifyProfileId(name, existingIds = []) {
  const taken = new Set(existingIds);
  const raw = String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[-_]+$/, "")
    .slice(0, 28);
  const base = raw && PROFILE_ID_RE.test(raw) ? raw : "account";
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const suffix = `-${i}`;
    const candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error("Too many Antigravity profiles");
}

export function profilesRoot(appHome) {
  return join(resolve(appHome), "data", "antigravity-profiles");
}

export function profilesStorePath(appHome) {
  return join(profilesRoot(appHome), "profiles.json");
}

function assertInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Profile path escapes profile storage root");
  }
}

export function profilePaths(appHome, id) {
  validateProfileId(id);
  const base = profilesRoot(appHome);
  const root = join(base, id);
  assertInside(base, root);
  const home = join(root, "home");
  const gemini = join(home, ".gemini");
  return {
    root,
    home,
    gemini,
    agyHome: join(gemini, "antigravity-cli"),
    configDir: join(gemini, "config"),
  };
}

function atomicWriteJson(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temp, file);
  } finally {
    try { unlinkSync(temp); } catch {}
  }
}

export function sanitizeProfiles(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.id !== "string" || !PROFILE_ID_RE.test(item.id) || seen.has(item.id)) continue;
    const name = typeof item.name === "string" ? item.name.trim().replace(/\s+/g, " ").slice(0, MAX_NAME_LEN) : "";
    if (!name) continue;
    seen.add(item.id);
    out.push({
      id: item.id,
      name,
      ...(Number.isSafeInteger(item.createdAt) ? { createdAt: item.createdAt } : {}),
    });
    if (out.length >= MAX_PROFILES) break;
  }
  return out;
}

export function loadProfiles(appHome) {
  const file = profilesStorePath(appHome);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    return sanitizeProfiles(parsed?.profiles);
  } catch {
    return [];
  }
}

export function saveProfiles(appHome, profiles) {
  const clean = sanitizeProfiles(profiles);
  atomicWriteJson(profilesStorePath(appHome), { version: 1, profiles: clean });
  return clean;
}

// Check signed-in status strictly by token file presence and non-zero size.
// Never reads, parses, or logs OAuth credentials.
export function isProfileSignedIn(appHome, id) {
  let paths;
  try { paths = profilePaths(appHome, id); } catch { return false; }
  if (!existsSync(paths.agyHome)) return false;
  try {
    for (const name of readdirSync(paths.agyHome)) {
      if (name === "acp_token.json" || name.endsWith("-oauth-token")) {
        const info = statSync(join(paths.agyHome, name));
        if (info.isFile() && info.size > 0) return true;
      }
    }
  } catch {}
  return false;
}

export function listProfilesWithStatus(appHome) {
  return loadProfiles(appHome).map(profile => {
    const paths = profilePaths(appHome, profile.id);
    return {
      ...profile,
      signedIn: isProfileSignedIn(appHome, profile.id),
      home: paths.home,
      agyHome: paths.agyHome,
    };
  });
}

function safeSymlink(target, linkPath, isDir, platform = process.platform) {
  try {
    const existing = lstatSync(linkPath);
    if (existing.isSymbolicLink()) {
      const currentTarget = readlinkSync(linkPath);
      if (resolve(dirname(linkPath), currentTarget) === resolve(target)) return true;
      unlinkSync(linkPath);
    } else {
      // Never overwrite a real file or directory owned by the profile.
      return false;
    }
  } catch {}
  try {
    symlinkSync(target, linkPath, platform === "win32" ? (isDir ? "junction" : "file") : undefined);
    return true;
  } catch {
    return false;
  }
}

function sameResolved(a, b, platform = process.platform) {
  const canonical = p => { try { return realpathSync(p); } catch { return resolve(p); } };
  const left = canonical(a), right = canonical(b);
  return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isInside(parent, candidate, platform = process.platform) {
  const canonical = p => { try { return realpathSync(p); } catch { return resolve(p); } };
  const p = canonical(parent), c = canonical(candidate);
  const rel = platform === "win32" ? relative(p.toLowerCase(), c.toLowerCase()) : relative(p, c);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function linkShadowHome(paths, userHome = homedir(), { platform = process.platform } = {}) {
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  mkdirSync(paths.gemini, { recursive: true, mode: 0o700 });
  mkdirSync(paths.agyHome, { recursive: true, mode: 0o700 });
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });

  const manifestFile = join(paths.home, LINK_MANIFEST);
  let previousLinks = [];
  try {
    const data = JSON.parse(readFileSync(manifestFile, "utf8"));
    if (Array.isArray(data?.links)) previousLinks = data.links.filter(n => typeof n === "string");
  } catch {}

  const activeLinks = new Set();
  if (userHome && existsSync(userHome) && !sameResolved(paths.home, userHome, platform)) {
    let entries = [];
    try { entries = readdirSync(userHome, { withFileTypes: true }); } catch {}
    for (const entry of entries) {
      const name = entry.name;
      if (SKIP_HOME_ENTRIES.has(name)) continue;
      const target = join(userHome, name);
      if (sameResolved(target, paths.root, platform) || sameResolved(target, paths.home, platform)) continue;
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try { isDir = statSync(target).isDirectory(); } catch { isDir = false; }
      }
      if (safeSymlink(target, join(paths.home, name), isDir, platform)) {
        activeLinks.add(name);
      }
    }

    // Prune stale Herdr-managed symlinks whose source was deleted from userHome.
    for (const oldName of previousLinks) {
      if (activeLinks.has(oldName) || SKIP_HOME_ENTRIES.has(oldName)) continue;
      const candidate = join(paths.home, oldName);
      try {
        const st = lstatSync(candidate);
        if (st.isSymbolicLink()) {
          const target = resolve(dirname(candidate), readlinkSync(candidate));
          if (isInside(userHome, target, platform)) unlinkSync(candidate);
        }
      } catch {}
    }

    // Link safe, non-credential user customizations from ~/.gemini/config (rules, skills, MCP servers).
    const realGeminiConfig = join(userHome, ".gemini", "config");
    for (const item of SHARED_GEMINI_CONFIG_ENTRIES) {
      const source = join(realGeminiConfig, item);
      if (!existsSync(source)) continue;
      let isDir = false;
      try { isDir = statSync(source).isDirectory(); } catch {}
      safeSymlink(source, join(paths.configDir, item), isDir, platform);
    }

    // Also link ~/.gemini/antigravity/global_skills if present.
    const realGlobalSkills = join(userHome, ".gemini", "antigravity", "global_skills");
    if (existsSync(realGlobalSkills)) {
      const profileAntigravity = join(paths.gemini, "antigravity");
      mkdirSync(profileAntigravity, { recursive: true, mode: 0o700 });
      safeSymlink(realGlobalSkills, join(profileAntigravity, "global_skills"), true, platform);
    }
  }

  atomicWriteJson(manifestFile, { version: 1, links: [...activeLinks].sort() });
  return paths;
}

export function profileEnvironment({
  appHome,
  id,
  name,
  baseEnv = process.env,
  userHome = homedir(),
  platform = process.platform,
}) {
  const paths = profilePaths(appHome, id);
  const resolvedAppHome = resolve(appHome);
  const env = { ...baseEnv };
  env.HOME = paths.home;
  if (platform === "win32") {
    env.USERPROFILE = paths.home;
  }
  // Official agy 1.5+ environment variable (composite_token_storage.go):
  // forces file-based OAuth token storage inside appDataDir instead of macOS Keychain / OS keyring.
  env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE = "1";
  env.ANTIGRAVITY_CLI_HOME = paths.agyHome;
  env.ANTIGRAVITY_CONFIG_DIR = paths.configDir;
  env.HERDR_APP_HOME = resolvedAppHome;
  env.HERDR_ANTIGRAVITY_PROFILE = id;
  env.HERDR_ANTIGRAVITY_PROFILE_NAME = (name || id).slice(0, MAX_NAME_LEN);
  env.HERDR_REAL_HOME = userHome;

  // Keep standard user directories pointing at the real home so git, ssh,
  // cargo, 1Password, hc, and other tools work identically across profiles.
  if (!env.XDG_CONFIG_HOME) env.XDG_CONFIG_HOME = join(userHome, ".config");
  if (!env.XDG_CACHE_HOME) env.XDG_CACHE_HOME = join(userHome, ".cache");
  if (!env.XDG_DATA_HOME) env.XDG_DATA_HOME = join(userHome, ".local", "share");
  if (!env.XDG_STATE_HOME) env.XDG_STATE_HOME = join(userHome, ".local", "state");

  const gitConfig = join(userHome, ".gitconfig");
  if (!env.GIT_CONFIG_GLOBAL && existsSync(gitConfig)) env.GIT_CONFIG_GLOBAL = gitConfig;
  const cargoHome = join(userHome, ".cargo");
  if (!env.CARGO_HOME && existsSync(cargoHome)) env.CARGO_HOME = cargoHome;
  const rustupHome = join(userHome, ".rustup");
  if (!env.RUSTUP_HOME && existsSync(rustupHome)) env.RUSTUP_HOME = rustupHome;

  return env;
}

export function prepareProfile({
  appHome,
  id,
  name,
  baseEnv = process.env,
  userHome = homedir(),
  platform = process.platform,
  installHooks = true,
  installStatus = true,
}) {
  const paths = profilePaths(appHome, id);
  const saved = loadProfiles(appHome).find(p => p.id === id);
  const displayName = name || saved?.name || id;
  linkShadowHome(paths, userHome, { platform });
  const env = profileEnvironment({ appHome, id, name: displayName, baseEnv, userHome, platform });
  let hooksResult = null;
  let statusLineResult = null;
  if (installHooks) {
    // Pass real userHome so install() sees ANTIGRAVITY_CONFIG_DIR != default ~/.gemini/config
    // and installs strictly inside this profile, never touching the user's shared config.
    const results = installRecoveryHooks(resolve(appHome), env, platform, userHome, "antigravity");
    hooksResult = results[0] || null;
  }
  if (installStatus) {
    statusLineResult = installStatusLine({ home: resolve(appHome), env, platform, userHome });
  }
  return { id, name: displayName, paths, env, hooksResult, statusLineResult };
}

export function addProfile({ appHome, name, id, baseEnv = process.env, userHome = homedir(), platform = process.platform }) {
  const cleanName = normalizeProfileName(name);
  const existing = loadProfiles(appHome);
  if (existing.length >= MAX_PROFILES) throw new Error("Maximum number of Antigravity profiles reached");
  const nextId = id ? validateProfileId(id) : slugifyProfileId(cleanName, existing.map(p => p.id));
  if (existing.some(p => p.id === nextId)) throw new Error(`Profile "${nextId}" already exists`);
  const created = { id: nextId, name: cleanName, createdAt: Date.now() };
  const profiles = saveProfiles(appHome, [...existing, created]);
  const prepared = prepareProfile({ appHome, id: nextId, name: cleanName, baseEnv, userHome, platform });
  return { profile: created, profiles, prepared };
}

function unlinkDirectSymlinks(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    try {
      const st = lstatSync(full);
      if (st.isSymbolicLink()) unlinkSync(full);
    } catch {}
  }
}

export function removeProfile({ appHome, id }) {
  validateProfileId(id);
  const paths = profilePaths(appHome, id);
  // Defense-in-depth: explicitly unlink every symlink inside the shadow home
  // and profile .gemini/config before removing the profile directory so no
  // real file or directory in the user's home can ever be traversed or deleted.
  if (existsSync(paths.root)) {
    unlinkDirectSymlinks(paths.home);
    unlinkDirectSymlinks(paths.configDir);
    unlinkDirectSymlinks(join(paths.gemini, "antigravity"));
    rmSync(paths.root, { recursive: true, force: true });
  }
  const existing = loadProfiles(appHome);
  const next = saveProfiles(appHome, existing.filter(p => p.id !== id));
  return { removed: id, profiles: next };
}

export function profileLauncherArgv({ appHome, id, name, agyArgv = ["agy"], nodePath = process.execPath }) {
  validateProfileId(id);
  const runner = join(resolve(appHome), "mods", "antigravity-profiles", "runner.mjs");
  const args = [nodePath, runner, "--profile", id];
  if (name) args.push("--name", String(name).slice(0, MAX_NAME_LEN));
  args.push("--home", resolve(appHome), "--", ...agyArgv);
  return args;
}

export function labelTerminalProfile(id, name, { env = process.env, platform = process.platform } = {}) {
  if (!/^t[0-9a-z]+$/.test(env.HC_TERMINAL_ID || "")) return false;
  const { execFileSync } = require("node:child_process");
  const binary = platform === "win32" ? "hc.exe" : "hc";
  try {
    execFileSync(
      binary,
      [
        "label",
        env.HC_TERMINAL_ID,
        `herdr.antigravity.profile=${id}`,
        `herdr.antigravity.profile_name=${(name || id).slice(0, MAX_NAME_LEN)}`,
      ],
      { env, windowsHide: true, timeout: 2500, stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}
