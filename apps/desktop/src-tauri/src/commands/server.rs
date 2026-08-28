// 提供 WebView 查询 Server 连接信息的命令。
use std::time::Duration;

use crate::processes::DesktopProcesses;

#[tauri::command]
pub async fn get_server_secret(
    state: tauri::State<'_, DesktopProcesses>,
) -> Result<String, String> {
    state
        .wait_for_server(Duration::from_secs(30))
        .await
        .map(|connection| connection.secret)
        .ok_or_else(|| "server secret not yet available".to_string())
}

#[tauri::command]
pub async fn get_server_port(state: tauri::State<'_, DesktopProcesses>) -> Result<u16, String> {
    state
        .wait_for_server(Duration::from_secs(30))
        .await
        .map(|connection| connection.port)
        .ok_or_else(|| "server port not yet available".to_string())
}
