// Narrative 设置页的手动启动, 当前端口查询和 Python 完全退出确认.
use crate::processes::DesktopProcesses;

#[tauri::command]
pub async fn start_narrative(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopProcesses>,
) -> Result<u16, String> {
    state.start_narrative_manually(app).await
}

#[tauri::command]
pub async fn get_narrative_port(
    state: tauri::State<'_, DesktopProcesses>,
) -> Result<Option<u16>, String> {
    Ok(state.narrative_port().await)
}

#[tauri::command]
pub async fn wait_narrative_exit(state: tauri::State<'_, DesktopProcesses>) -> Result<(), String> {
    state.wait_narrative_exit().await
}
