// 提供窗口显示、交互模式与应用退出相关的 Tauri commands。
use tauri::Manager;

use crate::desktop::window_lifecycle::show_window;
use crate::runtime::DesktopRuntimeSupervisor;

#[tauri::command]
pub fn set_always_on_top(window: tauri::Window, value: bool) -> Result<(), String> {
    window
        .set_always_on_top(value)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_passthrough(window: tauri::Window, value: bool) -> Result<(), String> {
    window
        .set_ignore_cursor_events(value)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn quit_app(app: tauri::AppHandle) {
    let state = app.state::<DesktopRuntimeSupervisor>();
    state.shutdown().await;
    app.exit(0);
}

#[tauri::command]
pub fn open_window(app: tauri::AppHandle, label: String) -> Result<(), String> {
    show_window(&app, &label)
}
