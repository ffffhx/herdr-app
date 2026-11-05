//! Optional local instrumentation. Ordinary builds never start an endpoint.
use gpui::{App, Window};
use gpui_mcp::{AppId, BridgeConfig, BridgeHandle};

pub fn install(window: &mut Window, cx: &App) -> Option<BridgeHandle> {
    if std::env::var("HERDR_GPUI_DEBUG").as_deref() != Ok("1") {
        return None;
    }
    let id = AppId::new("herdr-app").expect("static bridge application id");
    match BridgeHandle::install(window, cx, BridgeConfig::new(id, "Herdr")) {
        Ok(bridge) => Some(bridge),
        Err(error) => {
            tracing::error!("ProfilePilot GPUI bridge unavailable: {error}");
            None
        }
    }
}
