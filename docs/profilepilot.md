# ProfilePilot GPUI development bridge

Herdr's optional `profilepilot` feature connects its native window to the
ProfilePilot GPUI route. This is a developer build option, with an additional
runtime opt-in; the normal build starts no bridge endpoint.

Build with `cargo build --locked --features profilepilot`. Start with
`HERDR_GPUI_DEBUG=1` in the launching process environment. Keep the desktop app
independent of an agent shell. For testing, set `HERDR_APP_HOME` to a scratch
directory and `HC_SESSION` to an isolated core; never open a second window on the
person's existing home. A user's explicit installation/restart request may use
their existing home after the previous instance exits.

On Windows, `scripts/start-profilepilot-windows.ps1` starts the installed app
independently with the opt-in environment variable. Run it with ordinary-user
Windows PowerShell 5.1 (`-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy
Bypass -File ...`). It refuses elevation so the GUI shares the normal user's
core. A local installation can expose this as a separate **Herdr (ProfilePilot)**
shortcut; the regular shortcut retains ordinary startup behavior. Keep test
homes short (or relative to an explicit working directory), since Herdr's
existing control socket has a Windows AF_UNIX path length limit. Pass `-Background`
for a nonactivating launch (used by daily updates). It sets
`HERDR_APP_BACKGROUND=1` in the child. The same app flag works with the macOS
bundle launch flow; ordinary launches retain their normal activation behavior.

Use `ppilot gpui list` to discover the actual target ID, then:

```text
ppilot gpui claim --target <discovered-id> --session herdr-check
ppilot gpui snapshot --session herdr-check
ppilot gpui call --session herdr-check --tool screenshot --output <new.png>
ppilot gpui complete --session herdr-check
```

Input requires a fresh observation and the same active session. On takeover,
pause or uncertain results, inspect state and wait for the user to return
control. Do not use desktop automation or raw IPC to bypass that session.

Some custom input controls do not expose `set_text` or their current value in
the semantic tree yet. Open/focus them through their normal UI, use `type_text`
or `keyboard`, and verify the result with a screenshot; do not infer success
from an empty value or an input acknowledgement alone. Screenshots require a
restored window; a minimized window cannot be captured by the Windows backend.

The bridge handle belongs to the window. It closes when the window closes;
failure to start it is logged and leaves normal Herdr use available. The bridge
is for local debugging; ClipRelay's phone connection independently talks to
`herdr-core` through its authenticated host service.

The app-side bridge and protocol are pinned to gpui-mcp revision
`eb248ccf43847797b9067c47eeef1dd188dc03a6`, protocol 14. Its frame observer patch
has been ported to Herdr's vendored gpui-pre 0.3.8, preserving existing capture
and platform patches. See `vendor/gpui-mcp/HERDR.md` for provenance.
