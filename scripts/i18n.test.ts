import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import catalog from "../locales/zh-CN.json";
import { english } from "./i18n-fixture";

test("every Chinese message preserves its interpolation parameters", () => {
  const params = (s: string) => [...new Set(s.match(/\{\d+\}/g) ?? [])].sort();
  for (const [source, translated] of Object.entries(catalog)) {
    expect(translated.trim().length, source).toBeGreaterThan(0);
    expect(params(translated), source).toEqual(params(source));
  }
});

test("all shipped JavaScript modules remain syntactically valid", async () => {
  const parser = new Bun.Transpiler({ loader: "js" });
  for await (const file of new Bun.Glob("defaults/**/*.js").scan()) {
    const source = await readFile(file, "utf8");
    expect(() => parser.transformSync(source), file).not.toThrow();
  }
});

test("palette changes language without changing command IDs, grouping, or English search", async () => {
  let language = "zh-CN";
  const source = (await readFile(new URL("../defaults/frame/palette/main.js", import.meta.url), "utf8"))
    .replace(/^import .*;\r?\n/gm, "").replace("export default class Palette", "return class Palette");
  const values = {
    View: class {}, window: () => ({ platform: "windows" }), win: () => ({ platform: "windows" }),
    commands: () => ["tab.new", "app.settings", "pane.go", "layout.switch"].map(name => ({ name, args: [] })),
    layouts: () => ["main", "terminals"],
    tr: (s: string, args: (string | number)[] = []) => english(language === "zh-CN" ? (catalog as Record<string, string>)[s] ?? s : s, args),
  };
  const Palette = new Function(...Object.keys(values), source)(...Object.values(values));
  const palette = new Palette();
  palette.query = ""; palette.recent = [];
  const chinese = palette.rows().map((r: any) => r.e);
  expect(chinese.find((e: any) => e.name === "tab.new").title).toBe("新建标签页");
  expect(chinese.find((e: any) => e.name === "layout.switch" && e.args.name === "main").group).toBe("Layout");
  for (const query of ["新建标签页", "New tab"]) {
    palette.query = query;
    expect(palette.rows()[0].e.name).toBe("tab.new");
  }
  language = "en"; palette.query = "";
  const englishRows = palette.rows().map((r: any) => r.e);
  expect(englishRows.map((e: any) => e.id)).toEqual(chinese.map((e: any) => e.id));
  expect(englishRows.find((e: any) => e.name === "tab.new").title).toBe("New tab");
});
