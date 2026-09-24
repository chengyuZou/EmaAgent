// 桌面宿主开机时只读 Profile SQL 中的 Narrative 启动偏好.
use rusqlite::{Connection, OpenFlags, OptionalExtension};

use super::profile::profile_root;

pub(crate) fn read_start_narrative_on_launch() -> Result<bool, String> {
    let path = profile_root()?.join("profile.db");
    if !path.exists() {
        return Ok(true);
    }
    let db = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("open profile database {}: {error}", path.display()))?;
    let value: Option<String> = db
        .query_row(
            "SELECT value_json FROM settings WHERE key = ?1",
            ["narrative.startOnLaunch"],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("read Narrative launch preference: {error}"))?;
    match value {
        Some(json) => serde_json::from_str::<bool>(&json)
            .map_err(|error| format!("parse Narrative launch preference: {error}")),
        None => Ok(true),
    }
}
