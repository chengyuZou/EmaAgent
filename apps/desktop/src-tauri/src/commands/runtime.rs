// 提供 WebView 查询 Core 连接信息与桌面运行时状态的命令。
use std::time::Duration;

use crate::runtime::{DesktopRuntimeSupervisor, RuntimeSnapshot};

#[tauri::command]
pub async fn get_sidecar_secret(
    state: tauri::State<'_, DesktopRuntimeSupervisor>,
) -> Result<String, String> {
    state
        .get_secret()
        .await
        .ok_or_else(|| "sidecar secret not yet available".to_string())
}

#[tauri::command]
pub async fn get_sidecar_port(
    state: tauri::State<'_, DesktopRuntimeSupervisor>,
) -> Result<u16, String> {
    state
        .wait_for_port(Duration::from_secs(30))
        .await
        .ok_or_else(|| "sidecar port not yet available".to_string())
}

#[tauri::command]
pub async fn get_runtime_snapshot(
    state: tauri::State<'_, DesktopRuntimeSupervisor>,
) -> Result<RuntimeSnapshot, String> {
    Ok(state.snapshot().await)
}
