import { english } from "./i18n-fixture";
import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";

const source = (await readFile(new URL("../defaults/mods/agents/main.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").replace("export default class Agents", "class Agents");

function harness(pins: string[], host: Record<string, unknown> = {}) {
  const data = new Map([["pins", JSON.stringify(pins)]]);
  const writes: unknown[] = [];
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v), removeItem: (k: string) => data.delete(k) };
  const Agents = new Function("tr", "View", "localStorage", "props", "run", ...Object.keys(host), `${source}; return Agents;`)(
    english,
    class {}, storage, () => ({}), (...args: unknown[]) => writes.push(args), ...Object.values(host),
  );
  const agents = new Agents();
  agents.init({}, { timer: { every() {} } });
  return { agents, data, writes };
}

test("legacy pins migrate once listed, retaining offline pins until their labels arrive", () => {
  const { agents, data, writes } = harness(["t1", "offline/t2"]);
  agents.migratePins([]);
  expect(JSON.parse(data.get("pins")!)).toEqual(["t1", "offline/t2"]);
  const local = { address: "t1", state: "live", labels: {} };
  agents.migratePins([local]);
  agents.migratePins([local]);
  expect(writes).toEqual([["terminal.pin", { terminal: "t1", pinned: true }]]);
  expect(JSON.parse(data.get("pins")!)).toEqual(["t1", "offline/t2"]);
  agents.migratePins([{ ...local, labels: { "herdr.pinned": "1" } }]);
  expect(JSON.parse(data.get("pins")!)).toEqual(["offline/t2"]);
  const remote = { address: "offline/t2", state: "live", labels: {} };
  agents.migratePins([remote]);
  expect(writes).toHaveLength(2);
  agents.migratePins([{ ...remote, labels: { "herdr.pinned": "1" } }]);
  expect(data.has("pins")).toBe(false);
});

test("already shared pins need no write and pending writes survive restart", () => {
  expect(harness([]).data.has("pins")).toBe(false);
  const { agents, data, writes } = harness(["t1"]);
  agents.migratePins([{ address: "t1", state: "live", labels: { "herdr.pinned": "1" } }]);
  expect(writes).toHaveLength(0);
  expect(data.has("pins")).toBe(false);
  const retry = harness(["t2"]);
  retry.agents.migratePins([{ address: "t2", state: "live", labels: {} }]);
  expect(JSON.parse(retry.data.get("pins")!)).toEqual(["t2"]);
  const restarted = harness(JSON.parse(retry.data.get("pins")!));
  restarted.agents.migratePins([{ address: "t2", state: "live", labels: {} }]);
  expect(restarted.writes).toHaveLength(1);
});

test("an unnamed tab's row reads its terminal's title, not the tab number", () => {
  const title = new Function("tr", "View", "localStorage", "props", "run", `${source}; return title;`)(english, class {}, {}, () => ({}), () => {});
  const claude = { program: { name: "claude", key: "claude" }, title: "Herdr session names" };
  expect(title({ name: "3", named: false }, claude)).toBe("Herdr session names");
  expect(title({ name: "claude", named: true }, claude)).toBe("Herdr session names");
  expect(title({ name: "fix login", named: true }, claude)).toBe("fix login");
  expect(title({ name: "3", named: false }, { ...claude, title: "claude" })).toBe("3");
});

test("working agent rows in both sidebar widths focus the adopted pane in its owning space", () => {
  const agent = { address: "t41", pane: "p93", tab: "tb8", space: "sp2", space_name: "~", status: "working", title: "fix-profilepilot-ci" };
  const terminal = { address: agent.address, state: "live", labels: { "herdr.space": agent.space } };
  for (const width of [268, 76]) {
    const clicks = new Map<string, () => void>();
    const element = () => {
      let id = "";
      const el: any = new Proxy({}, { get: (_, method) => (...args: any[]) => {
        if (method === "id") id = args[0];
        if (method === "on_click") clicks.set(id, args[0]);
        if (method === "when" && args[0]) args[1](el);
        return el;
      } });
      return el;
    };
    const shared = new Map<string, unknown>();
    const { agents, writes } = harness([], {
      agents: () => [agent], terminals: () => [terminal], focused: () => ({ pane: "p1" }),
      spaces: () => [{ id: "sp1", active: true, tabs: [{ id: "tb1", name: "1" }] },
                     { id: agent.space, tabs: [{ id: agent.tab, name: "8" }] }],
      panes: () => [{ pane: agent.pane, tab: agent.tab, terminal: agent.address, title: agent.title }],
      layout: () => ({ id: "sidebar", size: { px: width } }), theme: () => ({}),
      shared: (key: string) => shared.get(key), setShared: (key: string, value: unknown) => shared.set(key, value),
      setAgentOrder() {}, div: element, svg: element, h_flex: element, v_flex: element,
    });
    agents.render();
    clicks.get(`ag-${agent.address}`)!();
    expect(writes).toEqual([["pane.focus", { pane: agent.pane }]]);
    expect(shared.get("tabs.revealAgent")).toEqual({ tab: agent.tab, serial: 1 });
    clicks.get(`ag-${agent.address}`)!();
    expect(shared.get("tabs.revealAgent")).toEqual({ tab: agent.tab, serial: 2 });
  }
});
