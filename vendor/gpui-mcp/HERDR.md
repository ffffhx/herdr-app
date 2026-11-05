# Herdr bridge provenance

Source: https://github.com/themixednuts/gpui-mcp
Revision: eb248ccf43847797b9067c47eeef1dd188dc03a6 (bridge protocol 14).
License: Apache-2.0; see LICENSE and upstream source headers.

Only the application bridge and protocol crates are vendored. Their Rust source
is unchanged. The workspace selects gpui-pre 0.3.8 and omits dependencies for
unused Zed and gpui-ce backends. Herdr keeps its existing GPUI and platform fixes.

The upstream gpui-pre 0.3.7 automation.patch is ported to vendor/gpui-pre 0.3.8.
Two context changes required resolving the window imports and initializing
frame_observers alongside the existing frame-capture state. No font, grid or
platform replacement patches are applied. The 0.3.8 view cache additionally
retains each replayed node's last canonical AccessKit description for frame
observers, so cached controls retain their actions. Fresh renders replace it;
removed nodes are discarded.

Build with --features profilepilot and launch with HERDR_GPUI_DEBUG=1 to enable
local authenticated discovery. The AppWindow owns the bridge for its lifetime.
The bridge has no access to ClipRelay's phone pairing or transport.
