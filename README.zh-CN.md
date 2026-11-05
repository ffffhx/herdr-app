# Herdr 中文版

基于 [herdrdev/herdr-app](https://github.com/herdrdev/herdr-app) 的中文分支。Herdr 是管理终端和编程 Agent 的桌面应用，可以同时查看多个 Agent、工作空间、标签页和 Git worktree。

## 使用

界面默认使用简体中文。打开 **设置 → 外观 → 界面语言** 可切换 English 或简体中文，设置会保存到 `settings.json` 的 `language` 字段（`zh-CN` / `en`）。已有设置未指定语言时也使用简体中文。

覆盖主布局、终端布局、Herdr 98、核心组件安装引导、首次启动向导、设置、命令面板、快捷键、Agent 列表、工作空间、文件、Git 变更和 worktree 对话框。命令面板同时支持中文标题和原英文标题搜索。

终端输出、Agent 回复、代码、文件路径、用户命名及第三方模组不自动翻译。上游在线发布说明保留原文。

## 下载

从本仓库的 [Releases](https://github.com/ffffhx/herdr-app/releases/latest) 下载预编译包，无需安装 Rust、Zig 或开启 Windows 开发者模式。

- **Windows x64**：下载 `herdr-app-zh-CN-windows-x86_64.zip`，完整解压到普通文件夹后运行 `herdr-app.exe`。
- **macOS Apple Silicon**：下载 `herdr-app-zh-CN-macos-aarch64.tar.gz`，解压后将 `Herdr.app` 拖入“应用程序”。不提供 Intel Mac 预编译包。
- **Linux**：按 CPU 架构下载 `linux-x86_64` 或 `linux-aarch64` 的 `.tar.gz`，解压后运行目录内的 `herdr-app`；需要图形桌面和相应系统运行库。

首次启动如提示缺少 herdr-core，按应用中的安装引导操作。发布包包含程序与开源声明，不内置 herdr-core。Windows 包未做代码签名，macOS 包采用临时签名且未公证，首次打开可能需要系统确认。

这是独立维护的中文构建，不自动更新为上游官方版。更新时从本仓库 Releases 下载新版，退出旧窗口后替换程序文件。普通发布包不启用可选的 ProfilePilot 调试桥；需要它时参见 [开发构建说明](docs/profilepilot.md)。

## 无人值守与自动审批

在工作空间中点击标签栏 **+ → 无人值守 Agent**，选择 Codex 或 Claude Code，填写任务和工作目录，再点 **开启自动审批并开始**。任务机器需安装 Node.js 20+，并已登录对应的 Agent CLI。

执行审批默认同意；选择题优先同意或推荐选项；“是否继续”会自动回复并续跑。例外框每行填写一个请求关键词，例如 `git push`，匹配后等待你处理。终端中可随时输入 `/auto off` 关闭、`/auto on` 开启，或 `/except 关键词` 添加例外。新会话使用原有 Agent 配置，不接管已有任务。

进度显示在独立终端中，面板可查看审批次数和日志位置。关闭 Herdr 窗口后任务仍由 herdr-core 托管；任务机器需要保持运行。缺失凭据、认证页面和未识别的请求不会被假装完成，重复追问也会显示为未完成。完整说明见 [Agent 使用指南](defaults/AGENTS.md#unattended-agents)。

## Windows 构建

本分支的 `localization` GitHub Actions 工作流构建经过优化的 Windows x64 程序并检查 JavaScript；`ci` 工作流在 Windows、macOS 和 Linux 运行 Rust 与渲染测试。成功后可从该次运行的 Artifacts 下载 `herdr-app-zh-CN-windows`，解压后运行 `herdr-app.exe`。这是自定义中文构建，不会自动用上游版本覆盖自身。运行终端仍需安装 herdr-core（`hc`）。

已有官方安装时，建议先将中文构建解压到独立目录进行体验。设置和会话仍遵循 Herdr 原有的存储规则；测试时可用 `HERDR_APP_HOME` 指定独立配置目录。

本地编译要求 Rust、Zig 和各平台依赖，详见 [上游构建说明](README.md#build-from-source)。运行：

```sh
cargo build --release --locked
bun test scripts/
cargo test --locked
```

打包自定义中文版时使用 `HERDR_APP_SELF_UPDATE=0 scripts/package`（Windows 使用 Git Bash）。本仓库的打包工作流会自动设置该选项。

## 维护翻译

- 中文词典：`locales/zh-CN.json`，英文原文作为键，无匹配时回退英文。
- JavaScript 模组：`import { tr } from "herdr"`，用 `tr("New tab")` 或 `tr("from {0}", [name])`。
- Rust 界面：`crate::i18n::tr`。插值只进行一次，用户数据中的占位符保持原样。
- 只翻译显示文本，命令名、状态枚举、路径、参数和用户数据保持原样。
- 新增翻译时同时检查中英文，运行测试确认占位符、菜单分组、命令搜索与用户内容没有受影响。

项目沿用 Apache-2.0 许可证，保留上游版权及第三方声明。
