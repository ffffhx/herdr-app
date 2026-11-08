//! Start the bundled recovery mod on the local core, independent of the window.
//! Provider hooks, persistence and resume policy live in the mod's Node runtime.
use std::{collections::hash_map::DefaultHasher, hash::{Hash, Hasher}, sync::Arc, time::Duration};
use serde_json::json;

pub fn start(core: Arc<crate::hc::Core>) {
    let core = Arc::downgrade(&core);
    std::thread::spawn(move || {
        while let Some(connection) = core.upgrade() {
            if let Err(error) = ensure(&connection) {
                tracing::warn!("agent recovery: {error:#}");
                let directory = crate::mods::app_dir().join("data/recovery");
                let _ = std::fs::create_dir_all(&directory);
                let updated = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis();
                let _ = std::fs::write(directory.join("error.json"), json!({"error": format!("{error:#}"), "updated": updated}).to_string());
            }
            drop(connection);
            std::thread::sleep(Duration::from_secs(10));
        }
    });
}

fn ensure(core: &crate::hc::Core) -> anyhow::Result<()> {
    let home = crate::mods::app_dir();
    let mut hash = DefaultHasher::new();
    home.hash(&mut hash);
    let name = format!("hdr-recover-{:016x}", hash.finish());
    let live = core.call("terminal.list", json!({}))?;
    if live["terminals"].as_array().is_some_and(|rows| rows.iter().any(|r| r["name"] == name && r["state"] == "live")) { return Ok(()); }
    let output = crate::spawn::command("node")
        .args(["-p", "JSON.stringify({path:process.execPath,major:Number(process.versions.node.split('.')[0])})"])
        .output().map_err(|e| anyhow::anyhow!("Session recovery requires Node.js 20+: {e}"))?;
    let node: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    anyhow::ensure!(output.status.success() && node["major"].as_u64().unwrap_or_default() >= 20, "Session recovery requires Node.js 20+");
    let node_path = node["path"].as_str().ok_or_else(|| anyhow::anyhow!("Cannot locate the Node.js runtime"))?;
    let mut env = serde_json::Map::new();
    env.insert("HERDR_RECOVERY_CORE".into(), json!(crate::core_bin::path()));
    // Preview agents must use their isolated configuration, never the daily
    // account's hook files. The core may have started with a different env.
    for key in ["CODEX_HOME", "CLAUDE_CONFIG_DIR"] {
        if let Ok(value) = std::env::var(key) { env.insert(key.into(), json!(value)); }
    }
    core.call("terminal.run", json!({
        "argv": [node_path, home.join("mods/recovery/service.mjs"), "serve", home],
        "env": env, "name": name, "no_parent": true, "no_notify": true,
        "outlive_parent": true, "rm": true
    }))?;
    Ok(())
}
