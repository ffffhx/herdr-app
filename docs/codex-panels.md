# Native Codex panels

The optional CLI patch in `scripts/codex-panels/native-panels.patch` targets
OpenAI Codex `rust-v0.169.0-alpha.3`, commit
`737775c30b0135ca89892da2a7fd394feede12d3`. It changes terminal presentation:

- In a local Herdr terminal running embedded Codex (`--no-daemon`), `/fork` keeps the original chat on the left and
  starts the native `codex fork <source-id>` in an independent terminal on the
  right. Both panes have their own Codex header, input and close button.
  Closing either pane or using `/quit` there leaves the other process running.
  The fork remains an ordinary persistent Codex conversation with full history.
  Outside Herdr, the existing in-terminal fork presentation remains available.
- Native subagents in local embedded Codex open separate Herdr terminal panes
  on the right, stacked vertically, each with its own Codex icon and header.
  They are read-only views of the parent-owned task: scroll with the wheel or
  Page Up/Down, use End to follow new output, and zoom/close with Herdr's pane
  controls. Send instructions through the parent Agent. Closing a view does
  not interrupt, resume, archive or unsubscribe the child task.
  Automatic creation preserves the current tab, input focus and zoom.
  Other hosts and older Herdr builds retain the in-terminal presentation.
- Closing an in-terminal fork or subagent panel hides that view without interrupting,
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

For in-terminal peers, `F8` switches between the main chat and the selected peer.
Click a panel heading or its tab to select another peer. `Ctrl+X`, then `Z`
zooms/restores the focused panel; `W` closes its view; `R` adjusts the split
with the arrow keys; `=` restores equal widths. Child panels share the right
column's height, so zoom a panel when its transcript needs more room.

The patch uses Herdr's `ls` and `pane.split` commands to locate the source
terminal; it never guesses from the currently active tab. Child panes require
the backward-compatible `pane.split` argument `focus:false`; the CLI checks
that capability before opening an external view. The separate fork CLI creates
its own native thread. A child viewer instead receives public transcript and
status snapshots from an authenticated loopback relay owned by the parent TUI.
It creates no app-server, model request, session database or second writer.
If the parent disconnects, the view labels its retained content as the last
received snapshot. `/side` continues to use the original in-terminal UI.
At narrow terminal widths, the upstream single-column fallback and pane focus
controls still apply to those in-terminal views.

## Build and validate on Windows

Use dedicated source and target directories with enough disk space. Cargo's
upstream Git dependencies have long filenames, so use a short Cargo home path
when Windows path limits apply. The build recipe downloads the exact pinned
source, applies the patch, runs the panel regression tests, and builds the CLI.
It does not install or restart anything.
The CLI tests compile additional dependency variants, so leave disk space beyond
what the normal executable build needs.

The full upstream TUI test program can exceed the available memory on a busy
16 GB machine even with one build job and incremental compilation disabled.
`-SkipUnitTests` skips that large unit-test program and records `unitTests: "skipped"` in the
build manifest. Use this only with explicit reporting of that validation gap
and the isolated UI checks below; it does not mean the unit tests passed.
The smaller `herdr_child` integration tests always run, including relay
authentication, initial replay, streaming replacement and owner disconnection.

Upstream check for this extension: official `herdrdev/herdr-app` master
`5216e6f` and relevant Codex/subagent pull requests were inspected on 2026-11-15.
No implementation of external native Codex child views was found; the existing
Herdr split panes, headers, icons and close/zoom controls are reused.

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
Point only the isolated CLI's test provider at its printed loopback port. Use
`--model gpt-5.4` for the fixture's direct function-call subagent responses. Send
`MAIN FIXTURE`, run `/fork`, then send `FORK FIXTURE`. Check two Herdr pane
headers, distinct terminal/process/session IDs and the fork's inherited history.
Close the fork using `/quit` and confirm that the original still accepts input.
Fork again, close the original using `pane.close`, and confirm that the fork
still accepts input. Test a named fork too; its name must remain literal text.
Return to a remaining chat and send `CREATE TWO CHILDREN` to exercise native subagent creation and
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
