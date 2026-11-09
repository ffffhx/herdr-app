# Native Codex panels

The optional CLI patch in `scripts/codex-panels/native-panels.patch` targets
OpenAI Codex `rust-v0.169.0-alpha.3`, commit
`737775c30b0135ca89892da2a7fd394feede12d3`. It changes terminal presentation:

- `/fork` keeps the original chat on the left and opens the full-history fork on
  the right. The fork remains an ordinary persistent Codex conversation.
- Native subagents appear automatically on the right, stacked vertically.
  Creation preserves the current input focus. Each panel can be selected,
  scrolled and expanded using Codex's existing pane controls.
- Closing a fork or subagent panel hides that view without interrupting,
  archiving or unsubscribing the native thread. The agent retains its normal
  task ownership and permissions.
- `/side` continues to use the upstream side-conversation rules.

Use the existing workspace presentation settings:

```toml
[features]
tui_workspace = true

[tui]
fullscreen_transcript = true
sidebar_width_percent = 50

[tui.keymap.global]
toggle_side_conversation = "f8"
```

With that keymap, `F8` switches between the main chat and the selected peer.
Click a panel heading or its tab to select another peer. `Ctrl+X`, then `Z`
zooms/restores the focused panel; `W` closes its view; `R` adjusts the split
with the arrow keys; `=` restores equal widths. Child panels share the right
column's height, so zoom a panel when its transcript needs more room.

The patch does not change Herdr's model, commands or shared mod APIs. Several
Codex views share one Herdr terminal and one native app-server connection.
It does not start a second writer on a child thread. At narrow terminal widths,
the upstream single-column fallback and pane focus controls still apply.

## Build and validate on Windows

Use dedicated source and target directories with enough disk space. Cargo's
upstream Git dependencies have long filenames, so use a short Cargo home path
when Windows path limits apply. The build recipe downloads the exact pinned
source, applies the patch, runs the panel regression tests, and builds the CLI.
It does not install or restart anything.

The full upstream TUI test program can exceed the available memory on a busy
16 GB machine even with one build job and incremental compilation disabled.
`-SkipUnitTests` builds the CLI only and records `unitTests: "skipped"` in the
build manifest. Use this only with explicit reporting of that validation gap
and the isolated UI checks below; it does not mean the unit tests passed.

The upstream tag bumps the workspace version without updating `Cargo.lock`.
The patch synchronizes those workspace package versions; external dependency
versions and checksums stay unchanged, and compilation uses `--locked`.
The Windows recipe also preserves the official binary's CRLF SQL migration
bytes. SQLx checksums include line endings, so an LF-only build would reject
existing Windows databases even when their schema is identical.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/codex-panels/build-windows.ps1 `
  -SourceDirectory D:/CodexWork/herdr-codex-panes-20261108 `
  -TargetDirectory D:/CodexBuild/herdr-codex-panes-20261108 `
  -CargoHome D:/cp8
```

Keep the upstream `codex-code-mode-host.exe` from the same CLI version next to
the preview `codex.exe`. Copy the build output before launching it. Use one
isolated Herdr preview with its own `HERDR_APP_HOME`, `HC_SESSION`, `CODEX_HOME`,
`APPDATA` and other provider homes. Preserve the user's foreground window and
active tabs. Run terminal input and screenshot checks through the preview's
CLI without activating the window.

`mock-responses.mjs` serves a local Responses API fixture without credentials.
Point only the isolated CLI's test provider at its printed loopback port. Send
`MAIN FIXTURE`, run `/fork`, then send `FORK FIXTURE`. Return to the original
chat and send `CREATE TWO CHILDREN` to exercise native subagent creation and
streaming. Verify both child transcripts, original/fork input isolation,
focus retention, closing a panel, resizing, and unchanged `/side` behavior.
Repeat with `-c features.multi_agent_v2=true` and check that parent-owned child
views still block direct input. The fixture supplies canned output for V2's
fresh child contexts; it does not implement out-of-band model task injection.
The fixture's tools only create test child conversations; it never returns
workspace command or edit requests.

Record the source revision, patch hash, binary hash and screenshots. Ask before
replacing the daily installation. Do not terminate running daily sessions.
Close only the task's preview window and stop its dedicated core and mock server
when validation finishes. Retain shared build caches and useful validation
records. An npm CLI update can replace a custom build; rebase and revalidate the
patch against that exact version before installing it again.
