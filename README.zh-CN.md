# Herdr 中文版

基于 [herdrdev/herdr-app](https://github.com/herdrdev/herdr-app) 的中文分支。Herdr 是管理终端和编程 Agent 的桌面应用，可以同时查看多个 Agent、工作空间、标签页和 Git worktree。

## 使用

界面默认使用简体中文。打开 **设置 → 外观 → 界面语言** 可切换 English 或简体中文，设置会保存到 `settings.json` 的 `language` 字段（`zh-CN` / `en`）。已有设置未指定语言时也使用简体中文。

覆盖主布局、终端布局、Herdr 98、首次启动向导、设置、命令面板、快捷键、Agent 列表、工作空间、文件、Git 变更和 worktree 对话框。命令面板同时支持中文标题和原英文标题搜索。

终端输出、Agent 回复、代码、文件路径、用户命名及第三方模组不自动翻译。上游在线发布说明保留原文。

## Windows 构建

本分支的 `localization` GitHub Actions 工作流构建 Windows x64 程序并运行测试。成功后可从该次运行的 Artifacts 下载 `herdr-app-zh-CN-windows`，解压后运行 `herdr-app.exe`。这是开发构建；不会自动用上游版本覆盖自身。运行终端仍需安装 herdr-core（`hc`）。

已有官方安装时，建议先将中文构建解压到独立目录进行体验。设置和会话仍遵循 Herdr 原有的存储规则；测试时可用 `HERDR_APP_HOME` 指定独立配置目录。

本地编译要求 Rust、Zig 和各平台依赖，详见 [上游构建说明](README.md#build-from-source)。运行：

```sh
cargo build --locked
bun test scripts/
cargo test --locked
```

## 维护翻译

- 中文词典：`locales/zh-CN.json`，英文原文作为键，无匹配时回退英文。
- JavaScript 模组：`import { tr } from "herdr"`，用 `tr("New tab")` 或 `tr("from {0}", [name])`。
- Rust 界面：`crate::i18n::tr`。插值只进行一次，用户数据中的占位符保持原样。
- 只翻译显示文本，命令名、状态枚举、路径、参数和用户数据保持原样。
- 新增翻译时同时检查中英文，运行测试确认占位符、菜单分组、命令搜索与用户内容没有受影响。

项目沿用 Apache-2.0 许可证，保留上游版权及第三方声明。
