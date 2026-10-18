use crate::processes::{DesktopProcesses, SERVER_READY_TIMEOUT};

#[tauri::command]
pub async fn get_server_secret(
    state: tauri::State<'_, DesktopProcesses>,
) -> Result<String, String> {
    state
        .wait_for_server(SERVER_READY_TIMEOUT)
        .await
        .map(|connection| connection.secret)
        .ok_or_else(|| "server secret not yet available".to_string())
}

#[tauri::command]
pub async fn get_server_port(state: tauri::State<'_, DesktopProcesses>) -> Result<u16, String> {
    state
        .wait_for_server(SERVER_READY_TIMEOUT)
        .await
        .map(|connection| connection.port)
        .ok_or_else(|| "server port not yet available".to_string())
}
