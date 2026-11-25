import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

import {
  addProfile,
  isProfileSignedIn,
  listProfilesWithStatus,
  loadProfiles,
  prepareProfile,
  profileEnvironment,
  profileLauncherArgv,
  profilePaths,
  removeProfile,
  slugifyProfileId,
  validateProfileId,
} from "../defaults/mods/antigravity-profiles/profiles.mjs";
import { runIsolated } from "../defaults/mods/antigravity-profiles/runner.mjs";
import { capture } from "../defaults/mods/recovery/hook.mjs";
import { commandLine, resumeArgv } from "../defaults/mods/recovery/model.mjs";
import { native } from "../defaults/mods/unattended/native.mjs";

const require = createRequire(import.meta.url);
const agyUsage = require("../defaults/mods/workspace-status/antigravity-usage.cjs");

function makeFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "herdr-agy-profiles-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const userHome = join(root, "user");
  const appHome = join(userHome, ".config", "herdr-app");
  mkdirSync(join(userHome, "works", "repo-a"), { recursive: true });
  mkdirSync(join(userHome, ".ssh"), { recursive: true });
  mkdirSync(join(userHome, ".gemini", "config", "skills", "custom-skill"), { recursive: true });
  mkdirSync(join(userHome, ".gemini", "antigravity-cli"), { recursive: true });
  mkdirSync(appHome, { recursive: true });
  writeFileSync(join(userHome, "works", "repo-a", "README.md"), "shared-repo\n");
  writeFileSync(join(userHome, ".gitconfig"), "[user]\n\tname = Test\n");
  writeFileSync(join(userHome, ".ssh", "config"), "Host example\n");
  writeFileSync(join(userHome, ".gemini", "config", "GEMINI.md"), "# Global rule\n");
  writeFileSync(join(userHome, ".gemini", "config", "mcp_config.json"), '{"mcpServers":{}}\n');
  writeFileSync(join(userHome, ".gemini", "antigravity-cli", "settings.json"), '{"defaultHome":true}\n');
  writeFileSync(join(userHome, ".gemini", "config", "hooks.json"), '{"existing":true}\n');
  return { root, userHome, appHome };
}

test("slugifyProfileId and validateProfileId produce safe unique slugs and reject traversal", () => {
  assert.equal(slugifyProfileId("Pro"), "pro");
  assert.equal(slugifyProfileId("Google AI Ultra"), "google-ai-ultra");
  assert.equal(slugifyProfileId("Pro", ["pro"]), "pro-2");
  assert.equal(slugifyProfileId("主账号", []), "account");
  assert.equal(slugifyProfileId("备用账号", ["account"]), "account-2");
  assert.equal(validateProfileId("pro_1-a"), "pro_1-a");
  for (const bad of ["", "../etc", "Pro", "a/b", "a b", "-bad", "a".repeat(33)]) {
    assert.throws(() => validateProfileId(bad), /Invalid Antigravity profile ID/);
  }
});

test("prepareProfile isolates .gemini, sets AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1, and leaves real ~/.gemini untouched", t => {
  const { userHome, appHome } = makeFixture(t);
  const { profile, prepared } = addProfile({
    appHome,
    name: "Ultra",
    userHome,
    baseEnv: { PATH: process.env.PATH },
  });
  assert.equal(profile.id, "ultra");
  assert.equal(profile.name, "Ultra");

  // Environment forces official file-based token storage and isolated HOME.
  assert.equal(prepared.env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE, "1");
  assert.equal(prepared.env.HOME, prepared.paths.home);
  assert.equal(prepared.env.ANTIGRAVITY_CLI_HOME, prepared.paths.agyHome);
  assert.equal(prepared.env.ANTIGRAVITY_CONFIG_DIR, prepared.paths.configDir);
  assert.equal(prepared.env.HERDR_APP_HOME, appHome);
  assert.equal(prepared.env.HERDR_ANTIGRAVITY_PROFILE, "ultra");
  assert.equal(prepared.env.HERDR_ANTIGRAVITY_PROFILE_NAME, "Ultra");
  assert.equal(prepared.env.XDG_CONFIG_HOME, join(userHome, ".config"));
  assert.equal(prepared.env.GIT_CONFIG_GLOBAL, join(userHome, ".gitconfig"));

  // .gemini is a real isolated directory, while repos, git, and ssh are linked.
  assert.equal(lstatSync(prepared.paths.gemini).isSymbolicLink(), false);
  assert.equal(lstatSync(join(prepared.paths.home, "works")).isSymbolicLink(), true);
  assert.equal(readFileSync(join(prepared.paths.home, "works", "repo-a", "README.md"), "utf8"), "shared-repo\n");
  assert.equal(readFileSync(join(prepared.paths.home, ".gitconfig"), "utf8"), "[user]\n\tname = Test\n");

  // Global non-credential customizations are shared; hooks and settings stay isolated.
  assert.equal(lstatSync(join(prepared.paths.configDir, "GEMINI.md")).isSymbolicLink(), true);
  assert.equal(lstatSync(join(prepared.paths.configDir, "skills")).isSymbolicLink(), true);
  assert.equal(lstatSync(join(prepared.paths.configDir, "mcp_config.json")).isSymbolicLink(), true);

  assert.equal(prepared.hooksResult?.state, "installed");
  assert.equal(prepared.statusLineResult?.state, "installed");
  const profileHooks = JSON.parse(readFileSync(join(prepared.paths.configDir, "hooks.json"), "utf8"));
  assert.equal(profileHooks["herdr-recovery"].PreToolUse[0].matcher, "*");
  const profileSettings = JSON.parse(readFileSync(join(prepared.paths.agyHome, "settings.json"), "utf8"));
  assert.equal(profileSettings.statusLine.type, "command");

  // The user's real ~/.gemini files must remain completely untouched.
  assert.equal(readFileSync(join(userHome, ".gemini", "antigravity-cli", "settings.json"), "utf8"), '{"defaultHome":true}\n');
  assert.equal(readFileSync(join(userHome, ".gemini", "config", "hooks.json"), "utf8"), '{"existing":true}\n');
});

test("isProfileSignedIn checks token presence without reading secrets and removeProfile never touches real home targets", t => {
  const { userHome, appHome } = makeFixture(t);
  addProfile({ appHome, name: "Pro", userHome, baseEnv: { PATH: process.env.PATH } });
  const paths = profilePaths(appHome, "pro");

  assert.equal(isProfileSignedIn(appHome, "pro"), false);
  writeFileSync(join(paths.agyHome, "jetski-standalone-oauth-token"), "SECRET_TOKEN_DATA");
  assert.equal(isProfileSignedIn(appHome, "pro"), true);
  const statusList = listProfilesWithStatus(appHome);
  assert.equal(statusList.length, 1);
  assert.equal(statusList[0].signedIn, true);
  assert.doesNotMatch(JSON.stringify(statusList), /SECRET_TOKEN_DATA/);

  // Removing the profile must delete only the isolated profile dir and NEVER affect linked real home files.
  removeProfile({ appHome, id: "pro" });
  assert.equal(existsSync(paths.root), false);
  assert.deepEqual(loadProfiles(appHome), []);
  assert.equal(readFileSync(join(userHome, "works", "repo-a", "README.md"), "utf8"), "shared-repo\n");
  assert.equal(readFileSync(join(userHome, ".ssh", "config"), "utf8"), "Host example\n");
  assert.equal(readFileSync(join(userHome, ".gemini", "config", "GEMINI.md"), "utf8"), "# Global rule\n");
});

test("two profiles remain completely isolated from each other and share local repos", t => {
  const { userHome, appHome } = makeFixture(t);
  const pro = addProfile({ appHome, name: "Pro", userHome, baseEnv: { PATH: process.env.PATH } }).prepared;
  const ultra = addProfile({ appHome, name: "Ultra", userHome, baseEnv: { PATH: process.env.PATH } }).prepared;
  assert.notEqual(pro.paths.home, ultra.paths.home);
  assert.notEqual(pro.paths.agyHome, ultra.paths.agyHome);
  writeFileSync(join(pro.paths.agyHome, "antigravity-oauth-token"), "PRO_TOKEN");
  assert.equal(isProfileSignedIn(appHome, "pro"), true);
  assert.equal(isProfileSignedIn(appHome, "ultra"), false);
  assert.equal(realpathSync(join(pro.paths.home, "works", "repo-a")), realpathSync(join(ultra.paths.home, "works", "repo-a")));
});

test("runner.mjs executes target command with isolated HOME, file token storage, and forwarded args/exit code", async t => {
  const { userHome, appHome } = makeFixture(t);
  addProfile({ appHome, name: "Ultra", userHome, baseEnv: { PATH: process.env.PATH } });
  const outFile = join(appHome, "captured-env.json");
  const stub = join(appHome, "stub-agy.cjs");
  writeFileSync(stub, `
    const fs = require("node:fs");
    fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({
      argv: process.argv.slice(2),
      HOME: process.env.HOME,
      AGY_CLI_FORCE_FILE_TOKEN_STORAGE: process.env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE,
      HERDR_ANTIGRAVITY_PROFILE: process.env.HERDR_ANTIGRAVITY_PROFILE,
      HERDR_ANTIGRAVITY_PROFILE_NAME: process.env.HERDR_ANTIGRAVITY_PROFILE_NAME,
      HERDR_APP_HOME: process.env.HERDR_APP_HOME,
    }));
    process.exit(7);
  `);
  const result = await runIsolated(
    ["--profile", "ultra", "--home", appHome, "--", process.execPath, stub, "--conversation", "12345678-1234-1234-1234-123456789abc"],
    { env: { ...process.env, HOME: userHome } },
  );
  assert.equal(result.code, 7);
  const captured = JSON.parse(readFileSync(outFile, "utf8"));
  assert.deepEqual(captured.argv, ["--conversation", "12345678-1234-1234-1234-123456789abc"]);
  assert.equal(captured.HOME, profilePaths(appHome, "ultra").home);
  assert.equal(captured.AGY_CLI_FORCE_FILE_TOKEN_STORAGE, "1");
  assert.equal(captured.HERDR_ANTIGRAVITY_PROFILE, "ultra");
  assert.equal(captured.HERDR_ANTIGRAVITY_PROFILE_NAME, "Ultra");
  assert.equal(captured.HERDR_APP_HOME, appHome);
});

test("unattended native launch prepares and injects isolated profile env directly into agy", async t => {
  const { userHome, appHome } = makeFixture(t);
  const taskPath = join(appHome, "task.json");
  writeFileSync(taskPath, JSON.stringify({
    agent: "antigravity",
    argv: ["agy"],
    task: "",
    cwd: join(userHome, "works", "repo-a"),
    profile: { id: "pro", name: "Pro" },
  }));
  let spawned = null;
  let labeled = null;
  const code = await native(taskPath, {
    platform: "darwin",
    env: { ...process.env, HOME: userHome, HERDR_APP_HOME: appHome },
    prepareAgyProfile: args => prepareProfile({ ...args, userHome }),
    labelProfile: (id, name) => { labeled = { id, name }; },
    launch: (command, args, options) => {
      spawned = { command, args, options };
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
    observe: async () => {},
  });
  assert.equal(code, 0);
  assert.deepEqual(labeled, { id: "pro", name: "Pro" });
  assert.equal(spawned.command, "agy");
  assert.equal(spawned.options.env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE, "1");
  assert.equal(spawned.options.env.HOME, profilePaths(appHome, "pro").home);
  assert.equal(spawned.options.env.HERDR_ANTIGRAVITY_PROFILE, "pro");
});

test("workspace-status quota records and displays per-profile Antigravity labels without leaking credentials", t => {
  const { userHome, appHome } = makeFixture(t);
  const now = 1800000000000;
  const term = { address: "t5", pid: 4321, created_ms: 900000, state: "live", labels: { "herdr.antigravity.profile": "ultra", "herdr.antigravity.profile_name": "Ultra" } };
  const payload = {
    product: "antigravity",
    email: "SECRET@example.com",
    model: { id: "claude-opus-4-6-thinking", display_name: "Claude Opus" },
    quota: { "3p-5h": { remaining_fraction: 0.72, reset_time: new Date(now + 120000).toISOString() } },
  };
  assert.equal(agyUsage.capture(payload, {
    env: { HC_TERMINAL_ID: "t5", HERDR_APP_HOME: appHome, HERDR_ANTIGRAVITY_PROFILE: "ultra", HERDR_ANTIGRAVITY_PROFILE_NAME: "Ultra" },
    userHome,
    now,
    core: () => term,
  }), true);
  const read = agyUsage.readUsage(appHome, term, now);
  assert.equal(read.status, "ok");
  assert.equal(read.pool, "3p");
  assert.equal(read.profile, "ultra");
  assert.equal(read.profileName, "Ultra");
  assert.doesNotMatch(JSON.stringify(read), /SECRET|email/i);
});

test("recovery captures Antigravity profile identity and resumes via isolated runner.mjs", async t => {
  const { userHome, appHome } = makeFixture(t);
  const id = "12345678-1234-1234-1234-123456789abc";
  const paths = profilePaths(appHome, "pro");
  const transcriptDir = join(paths.agyHome, "brain", id, ".system_generated", "logs");
  mkdirSync(transcriptDir, { recursive: true });
  const transcript = join(transcriptDir, "transcript.jsonl");
  writeFileSync(transcript, JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT" }) + "\n");

  const term = { address: "t8", created_ms: 100, pid: 55, cwd: join(userHome, "works", "repo-a"), keep: true, state: "live", labels: { "herdr.space": "s1" } };
  const doc = { version: 1, records: {} };
  const fakeCore = {
    async call(method) {
      if (method === "terminal.get") return term;
      if (method === "server.status") return { holder: { instance: "gen1" } };
      return {};
    },
    async update(_name, fn) {
      const next = fn(doc);
      if (next) Object.assign(doc, next);
      return doc;
    },
  };
  await capture(
    fakeCore,
    "antigravity",
    { conversationId: id, hookEventName: "SessionStart", cwd: term.cwd },
    "t8",
    async () => ({ pid: 77, executable: "/usr/local/bin/agy" }),
    { ANTIGRAVITY_CLI_HOME: paths.agyHome, HERDR_ANTIGRAVITY_PROFILE: "pro", HERDR_ANTIGRAVITY_PROFILE_NAME: "Pro" },
  );
  const saved = doc.records["t8:100"];
  assert.equal(saved.profile, "pro");
  assert.equal(saved.profileName, "Pro");
  assert.equal(saved.transcript, transcript);

  const argv = resumeArgv(saved, appHome, "/usr/bin/node");
  assert.deepEqual(argv, [
    "/usr/bin/node",
    join(appHome, "mods", "antigravity-profiles", "runner.mjs"),
    "--profile",
    "pro",
    "--name",
    "Pro",
    "--home",
    appHome,
    "--",
    "/usr/local/bin/agy",
    "--conversation",
    id,
  ]);
  assert.match(commandLine(saved, "zsh", appHome, "/usr/bin/node"), /runner\.mjs' '--profile' 'pro'.*'--conversation'/);
  assert.throws(() => resumeArgv({ ...saved, profile: "../bad" }, appHome), /profile is invalid/);
});

test("new-menu displays configured local Antigravity profiles and opens unattended launch with profile props", () => {
  const menuSource = readFileSync(new URL("../defaults/mods/new-menu/main.js", import.meta.url), "utf8")
    .replace(/^import .*;\r?\n/gm, "").replace("export default class", "class");
  const overlays = [], runs = [], closed = [];
  const space = { id: "s1", active: true, machine: null, folder: "/project", tabs: [{ id: "tab1" }] };
  function element() {
    const tree = { nodes: [], handlers: {} };
    const el = new Proxy(tree, { get: (target, key) => {
      if (key in target) return target[key];
      if (key === "when") return (yes, fn) => yes ? fn(el) : el;
      if (key === "child") return child => { tree.nodes.push(child); return el; };
      if (key === "children") return children => { tree.nodes.push(...children); return el; };
      return (...args) => { if (key === "id") tree.elementId = args[0]; if (key.startsWith("on_")) tree.handlers[key] = args[0]; return el; };
    } });
    return el;
  }
  const sharedMap = new Map([["antigravity.profiles", [{ id: "pro", name: "Pro" }, { id: "ultra", name: "Ultra" }]]]);
  const api = {
    View: class {}, tr: s => s, theme: () => ({}), div: element, svg: element, image: element, h_flex: element, v_flex: element,
    spaces: () => [space], panes: () => [{ focused: true, tab: "tab1", cwd: "/project/sub" }],
    props: () => ({ overlay: "menu" }), window: () => ({ platform: "macos" }), keys: () => [],
    shared: k => sharedMap.get(k), setShared: (k, v) => sharedMap.set(k, v),
    closeOverlay: id => closed.push(id), run: (...args) => runs.push(args),
    openOverlay: config => overlays.push(config),
  };
  const NewMenu = new Function(...Object.keys(api), `${menuSource}; return NewMenu;`)(...Object.values(api));
  const view = new NewMenu();
  view.agents = [{ key: "antigravity", name: "Antigravity", icon: "icons/antigravity.svg", installed: true, run: ["agy"] }];
  const tree = view.render();
  const find = (node, id) => node?.elementId === id ? node : node?.nodes?.map(child => find(child, id)).find(Boolean);

  find(tree, "antigravity-profile-ultra").handlers.on_click();
  assert.deepEqual(overlays[0], {
    mod: "unattended",
    kind: "dialog",
    width: 420,
    height: 200,
    props: {
      space: "s1",
      agent: "antigravity",
      launch: ["agy"],
      name: "Antigravity · Ultra",
      profile: { id: "ultra", name: "Ultra" },
      folder: "/project/sub",
    },
  });

  find(tree, "antigravity-accounts").handlers.on_click();
  assert.deepEqual(runs[0], [
    "tab.new",
    {
      name: "Antigravity accounts",
      space: "s1",
      mod: "antigravity-profiles",
      props: { space: "s1", folder: "/project/sub" },
    },
  ]);
});
