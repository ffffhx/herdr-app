# herdr-app: drive the person's window

This fork defaults to Simplified Chinese. `settings.json` stores `language`
(`zh-CN` or `en`), selectable in Settings > Look > Interface language.
CLI commands, identifiers and JSON protocol fields stay in English. Use these
stable identifiers when driving a Chinese window; do not translate user data.

Herdr shows spaces, tabs and panes. herdr-core (`hc`) runs their terminals
and keeps them alive when the window closes. Use `herdr-app` only to change
what the person sees. For starting, reading, messaging, waiting on or cleaning
up agents and programs, read `hc --skill` and use hc.
Your terminal address is `$HC_TERMINAL_ID`; it is not a pane ID.

The + menu's **Unattended agents** starts Codex or Claude Code with automatic
approval and an approval journal. Open its panel with
`herdr-app do tab.new --name "Unattended agents" --mod unattended`.
It requires Node.js 20+ and an authenticated CLI on the task machine; it starts
a separate native interactive session. An existing Codex/Claude Code terminal's
Herdr tab or pane right-click menu offers **Switch to unattended**. This attaches
a background approval observer to that exact terminal without restarting it,
interrupting work, clearing a draft or changing the tab, pane or conversation.
The original native agent interface remains fully interactive. Recognized native
permission cards are accepted once; unknown prompts and exception matches remain
visible for the person. Use **Turn automatic approval off** in the same right-click
menu or the Unattended agents panel. An **Unattended** badge on the original tab
and pane header follows the approval state. All slash commands in native terminals
keep their agent-defined meaning.
Observers subscribe to terminal state events, with a 10-second fallback and
automatic reconnection. Policy changes wake them immediately. State files update
on change or a 5-second heartbeat, rather than on a half-second polling loop.
Older protocol-runner sessions remain supported. Only those terminals use
`/auto off`, `/auto on`, `/except <keyword>`, `/allow <request-id>`,
`/deny <request-id>`, `/answer <id> <answer>`, `/exceptions`, `/status`, `/help`,
`/interrupt` and `/quit` as runner commands, not `herdr-app do` commands.
See the installed AGENTS.md's Unattended agents section for behavior and files.
Explicit exceptions and missing information remain pending; do not claim an
unattended task finished just because an approval was delivered.

## Inspect before acting

**Session recovery** (status bar and tab/pane menus) captures local Codex/Claude
root conversation IDs and resumes them in their original kept terminals after
process loss. Closing just the window preserves live programs. Open the panel
with `herdr-app do tab.new --name "Session recovery" --mod recovery` to see saved
IDs, failures, safe retries and the persistent automatic-recovery switch.
It needs Node.js 20+, the provider's allowed session hooks and a captured ID;
never guess IDs from the newest history in a folder. Manual Codex launches use
`codex --no-daemon`. An unknown send outcome is not replayed. Automatic approval
is restored only with the original enabled policy and exception list after a
hook or exact native resume process confirms the original conversation. See the installed AGENTS.md for
hook configuration, diagnostics and unsupported cases.

Development builds compiled with `--features profilepilot` can expose a local
GPUI debugging bridge when started with `HERDR_GPUI_DEBUG=1`. Use the discovered
instance from `ppilot gpui list` and follow ProfilePilot's claim, observation,
takeover and completion rules. The bridge is off unless both options are set;
ordinary `herdr-app` CLI commands keep their existing behavior. See
`docs/profilepilot.md` for the build and isolated validation procedure.

```sh
herdr-app ls          # spaces > tabs > terminals, including pane IDs
herdr-app status      # current layout, focus, overlays, zoom and file/mod errors
herdr-app commands    # available commands, arguments and descriptions
```

`ls` and `status` talk to the running window, not a new app. `commands`
prints the built-in command list even without an open window. Do not launch bare
`herdr-app` to inspect it: that opens or raises the window. Do not stop,
signal or restart the person's app or core. A window closing does not kill
its terminals.

`app.check_updates` checks for newer releases. Settings reports "Up to date"
only after a successful check; on failure, check the connection and retry.

## Show something when asked

New spaces and tabs are shown immediately: only create them when asked.
Pick an explicit, useful name for every new space and tab; don't rely on
default names. Use IDs from `ls` rather than guessing or acting on the wrong
focused pane.

```sh
herdr-app do space.new --name api --folder /path/to/api
herdr-app do tab.new --name "fix login" --argv '["claude"]' --task "Look at the login bug"
herdr-app do pane.split --direction right --pane p12
herdr-app do agent.focus --terminal t7
```

For a remote space:

```sh
herdr-app do space.new --name "remote api" --machine vps --folder /srv/api
```

The folder is on that machine; tabs and splits in the space stay there.
New-space keys and clicks follow the focused space's machine. Script commands
without `--machine` still use this computer; `--machine ''` explicitly chooses it.
The agent menu checks and starts agents in the remote Unix user's
login/interactive shell (sh, bash, zsh, dash, ksh or fish), including its
configured PATH. Other shells keep the sh launcher.
`terminal.open --folder /path --place down` starts the split in that folder,
including when `--argv` supplies a program. Without `--folder`, it follows the
focused terminal's folder.
`hc machine ls` lists machines. Use `hc run --on vps ...`, `hc exec --on vps ...`
and `hc file ... --on vps ...` for remote work, not your local file tools.

`do` accepts `--key value` arguments (JSON for arrays/objects) or one JSON
object. Unknown argument names fail and list valid names. Target IDs (`id`,
`pane`, `space`, `terminal`) must be strings; other non-null types fail before
the current-target default can apply. Null keeps its omitted-argument meaning.
Use `commands` to confirm the command's exact shape:

```sh
herdr-app do pane.split '{"direction":"right","pane":"p12"}'
```

It prints the created IDs (for example `{ "pane": "...", "terminal": "..." }`)
or `{ "error": "..." }` and exits 1. Read the result, then inspect `ls` or
`status` to confirm. Commands invoked by an agent never open a missing-argument
dialog: supply all required arguments. A successful launch reply means the
terminal was created, not that its program started correctly. If it exits
with a nonzero code within two seconds, the window shows an error toast with
the exit code and last output lines.

A terminal started with hc opts into the window with `herdr.space=<id>`.
`herdr.tab=<id>` chooses its tab; without it, Herdr creates a tab in that space.
Unlabeled workers stay hidden. Do not add labels just to run a background
worker. Use app commands when the
user wants to see a new tab or split, hc for orchestration that need not change
the screen.

## Customize layouts, keys, or mods

First read `~/.config/herdr-app/AGENTS.md` (or `$HERDR_APP_HOME/AGENTS.md` if
set). It is the installed guide to settings, layouts, commands and mods.
Read the generated `.d.ts` files beside it for full API details; do not edit
those files or the generated guide. The app rewrites them on start.

- Home defaults to `~/.config/herdr-app`; `HERDR_APP_HOME` selects another.
- Mods live in `mods/<name>/` with `main.js` and optional `mod.json`.
  They are trusted JavaScript with command and network access.
  The main layout's `workspace-status` shows local Codex/Claude subscription
  quota or the official DeepSeek API account's monetary balance, refreshes every
  30 seconds and on click, and puts reset times or balance details in its
  tooltip. DeepSeek uses the global Claude settings/environment; other Claude
  API providers show an unsupported-balance message instead of asking to log in.
  It uses the computer's CLI account (not terminal-specific account
  overrides); unsupported remote accounts and failed queries stay explicit.
  `"focusable": true` in `mod.json` lets `pane.go` move onto a copy; it receives
  `"focus"` from `nextCommand()` and focuses its own keyboard handle.
- Shipped mods belong to Herdr: duplicate with `mod.clone` before editing.
  Shipped layouts likewise use `layout.clone` for a personal copy.
  Discover required arguments with `herdr-app commands`.
- Save to reload. A broken save keeps the old version running and reports
  an error in `status`; a still-working screen is not proof the edit worked.
- Make only the requested change. Don't touch unrelated mods or settings.
- Use theme colors. Do not retain a mod's `cx` across callbacks; each
  callback receives its own. Native animations, not redraw timers, keep
  the window cheap to run. Root `on_size_change((size, cx) => …)` reports
  logical pixels after layout, including resizes without pointer movement.
  Optional `View.close(cx)` gets one bounded final call; start cleanup there,
  not in an earlier task. The installed guide explains its 250 ms quit budget
  and which cleanup commands go out before shutdown.

After every mod change:

```sh
herdr-app check ~/.config/herdr-app/mods/<name>
herdr-app status
herdr-app shot /tmp/mod.png   # then look at the picture
```

`check` loads the mod and renders it once. It exits nonzero with the exact
error. Never call a mod done without a passing check. Then confirm it is
shown correctly in the running window with `shot`; don't claim a visual
check you haven't made.

`herdr-app shot [file.png]` saves the window's last frame and prints its
absolute path (default: `herdr-shot.png` in your current folder). It is the
app's own rendering at full pixel size: terminals, images, overlays and
floats included, even when the window is covered or minimized. No screen
capture or permissions. It needs a running window that has drawn a frame;
`HERDR_APP_HOME` selects the window, as for `status`.

## Problems and safety

If Herdr misbehaves, `herdr-app feedback "<what happened>"` drafts a report.
The person reviews and sends it; it does not silently send feedback.

Never experiment with pointer/key automation on the person's real display.
When developing the app on Linux, its `scripts/sandbox` provides an isolated
home, core and display: `up`, `do`, `status`, `shot`, then `down` when done.
Never stop a server or session you didn't start.
