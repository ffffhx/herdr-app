# Personal fork feature audit — 2026-11-08

Baseline: the owner's requested additions and their latest revisions, rather than
reverting later fixes to an earlier implementation. Inspected all local/remote
branches, the personal commits by `hxf`/`ffffhx`, the installed development build
(`452299b`), main (`f2078a7`, documentation-only since that build), and the retained
Herdr 0.9.1 session configuration/history. No README or daily installation changed.

| Feature and latest evidence | Result |
| --- | --- |
| Native exact-session restart recovery in Herdr 0.9.1 (`session.resume_agents_on_restore`) | Missing in Herdr 2. Restored for local Codex/Claude through root hooks, durable claims and original-terminal resume; diagnostic panel, retry and persistent switch added. |
| Live terminals survive window close; layout, tabs, splits and focus persist | Already implemented by herdr-core keep and app documents. Recovery preserves these identities and does not resend a task. |
| Simplified Chinese / English switch, dynamic labels, Windows locale fixes (`b948711`, squashes `21a6dfd`–`8b9cd29`) | Present. New recovery UI also translated. |
| ProfilePilot GPUI control and optional dependency notices (`f0b3399`, `d0826b1`, `b1357c9`) | Present. Preview keeps the optional bridge. |
| Unattended creation, exception policies, approval journal, Windows discovery and environment casing (`a9a7c7d`–`990754f`) | Present and covered by the existing regression suite. |
| Enable unattended on the original native terminal, one confirmation, pane/tab menu, no restart or draft clearing (`d1d6f86` through latest `e58e47b`) | Present. Retain latest native observer implementation; do not revert to the older replacement-session flow. |
| Event-driven observer and fallback heartbeat (`1349ad1`) | Present. Added stale-badge cleanup, safe reclamation of dead native observer leases, and restoration of the prior enabled policy after an exact-session recovery. Disabled policies remain disabled; the panel follows recovered controls and retains earlier journals. |
| Codex/Claude subscription quota and DeepSeek API balance (`1ba0031`, `17e066b`) | Present. Preserved and regression-tested. |
| Tab wheel stops at either end (`1404502`) | Present; no wrap-around reintroduced. |
| Main-branch daily build, one shortcut, update backup, upstream auto-update disabled, isolated preview before installation (`bf32ff5`, `9779fbc`, `452299b`, `f2078a7`) | Present. Follow the latest isolation/install rules; do not restore superseded automatic daily restarts. |
| SSH spaces, remote native agent launch, keyboard/mouse splits, alerts and terminal rendering | Current implementations retained; no replacement by legacy APIs. |

The unmerged `origin/fix/durable-agent-session-capture` branch belongs to a
different author and records identities only (including pi); it does not implement
automatic startup resume. Its presence was not treated as proof that recovery was
already installed. Unrelated upstream experimental branches are not personal
feature requests and were not blindly merged.

Boundaries: no reliable terminal-to-conversation binding exists for already-lost
tabs from before hooks were installed. Their provider histories remain available
for explicit native resume. Old Herdr plugin APIs and all of the legacy provider
integrations have not been ported wholesale; unsupported providers/remote agents
continue as shells after process loss. This audit reports only features for which
source/history evidence was found, not exhaustive parity with every Herdr 0.9 API.

Windows recovery uses PowerShell quoting, native executable paths and Codex
`--no-daemon`. Unix uses shell-safe arguments and process ancestry via `ps`; macOS
retains the existing login-shell/PATH behavior. Regression checks are configured
in CI for Windows, macOS and Linux, but GitHub rejected dispatch because Actions
is disabled for this repository. Local interactive validation is Windows only;
macOS and Linux runtime validation remains outstanding.

Provider hook contracts: [Codex hooks](https://learn.chatgpt.com/docs/hooks).
Runtime verification uses the installed Codex 0.167.0. Its startup hook may be
deferred until the next user turn, so resume confirmation also checks native
argv and ancestry without sending a replacement task.

Validation completed locally:

- 256 Rust unit/integration/render checks passed; one unrelated live-core test
  remains opt-in. Both Chinese and English shipped-mod rendering checks pass.
- 98 JavaScript checks passed, including original unattended/quota regressions,
  recovery claims, changed identities, draft preservation, safe retry, hook
  configuration preservation, Unicode/quoted paths and dead-observer leases.
- An independently launched Windows preview used a separate app home, core
  session and provider homes. Closing/reopening the window retained the original
  terminal process. Abrupt loss of only the owned preview holder restored the
  test fixture and a real Codex 0.167.0 conversation with the same terminal/tab/ID;
  repeated loss did not submit additional user tasks.
- Native automatic approval resumed with its saved exception list and an active
  event observer after a holder loss. The real recovery panel's Chinese rendering
  and persistent enable/disable switch were checked through ProfilePilot.

After the user explicitly returned preview control, the final committed build
passed another real-conversation recovery check without an additional user turn.
The preview control session was completed and its window, core and test agents
were stopped. No daily app, default core, existing conversation, release or
installation was changed during validation. Final daily installation is a
separate approval under the repository's local rules.
