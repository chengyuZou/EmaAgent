// 读写只由桌面宿主消费的启动设置.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSettings {
    start_narrative_on_launch: bool,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            start_narrative_on_launch: true,
        }
    }
}

pub(crate) fn read_start_narrative_on_launch() -> Result<bool, String> {
    let path = settings_file()?;
    if !path.exists() {
        return Ok(DesktopSettings::default().start_narrative_on_launch);
    }
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("read desktop settings {}: {error}", path.display()))?;
    let settings: DesktopSettings = serde_json::from_str(&content)
        .map_err(|error| format!("parse desktop settings {}: {error}", path.display()))?;
    Ok(settings.start_narrative_on_launch)
}

pub(crate) fn write_start_narrative_on_launch(value: bool) -> Result<(), String> {
    let path = settings_file()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("create desktop settings directory {}: {error}", parent.display()))?;
    }
    let content = serde_json::to_string_pretty(&DesktopSettings {
        start_narrative_on_launch: value,
    })
    .map_err(|error| format!("serialize desktop settings: {error}"))?;
    fs::write(&path, content)
        .map_err(|error| format!("write desktop settings {}: {error}", path.display()))
}

fn settings_file() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "home directory is unavailable".to_string())?;
    Ok(home.join(".ema-agent").join("desktop.json"))
}
