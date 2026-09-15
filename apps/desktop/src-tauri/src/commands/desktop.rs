// 提供窗口显示、交互模式与应用退出相关的 Tauri commands。
use serde::Deserialize;
use tauri::Manager;

use crate::desktop::settings::{read_start_narrative_on_launch, write_start_narrative_on_launch};
use crate::desktop::windows::{begin_main_focus_settling, show_window};
use crate::processes::DesktopProcesses;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Live2dDiagnosticEvent {
    PresentationLoading,
    PresentationLoaded,
    PresentationFailed,
    ArchiveLoading,
    ArchiveLoaded,
    ArchiveFailed,
    CanvasCreated,
    TickerStarted,
    TickerStopped,
    ModelLoading,
    ModelReady,
    ModelFailed,
    FirstTick,
    PreviewExpression,
    PreviewMotion,
    PreviewPlacement,
    PreviewIgnored,
}

#[tauri::command]
pub fn report_live2d_diagnostic(
    window: tauri::Window,
    event: Live2dDiagnosticEvent,
    character_name: Option<String>,
    model_name: Option<String>,
    duration_s: Option<f64>,
    error_message: Option<String>,
) {
    tracing::info!(
        window = window.label(),
        ?event,
        ?character_name,
        ?model_name,
        ?duration_s,
        ?error_message,
        "Live2D stage diagnostic"
    );
}

#[tauri::command]
pub fn set_always_on_top(window: tauri::Window, value: bool) -> Result<(), String> {
    window
        .set_always_on_top(value)
        .map_err(|error| error.to_string())?;
    if window.label() == "main" && !value {
        begin_main_focus_settling();
    }
    Ok(())
}

#[tauri::command]
pub fn set_passthrough(window: tauri::Window, value: bool) -> Result<(), String> {
    window
        .set_ignore_cursor_events(value)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn quit_app(app: tauri::AppHandle) {
    tracing::info!("quit_app requested");
    let state = app.state::<DesktopProcesses>();
    state.shutdown().await;
    tracing::info!("supervised services shutdown complete; exiting");
    app.exit(0);
}

#[tauri::command]
pub async fn open_window(app: tauri::AppHandle, label: String) -> Result<(), String> {
    // WebView2 在 Windows 的同步 command 中创建窗口会与 UI 线程互等并死锁。
    // async command 由 Tauri 调度到异步线程，窗口首次惰性创建时不会冻住整个桌面宿主。
    tracing::info!(%label, "open_window requested");
    show_window(&app, &label).map_err(|error| {
        // 原生侧保留窗口创建错误，便于前端提示之外继续从 Desktop 日志定位。
        tracing::error!(%label, %error, "open_window failed");
        error
    })?;
    tracing::info!(%label, "open_window completed");
    Ok(())
}

#[tauri::command]
pub fn get_start_narrative_on_launch() -> Result<bool, String> {
    read_start_narrative_on_launch()
}

#[tauri::command]
pub fn set_start_narrative_on_launch(value: bool) -> Result<(), String> {
    write_start_narrative_on_launch(value)
}

#[tauri::command]
pub fn open_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    // 用宿主侧 opener 打开路径本身(KB 库目录等);自研 command 不经 WebView ACL。
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(&path, None::<&str>)
        .map_err(|error| {
            tracing::warn!(%path, %error, "open_path failed");
            error.to_string()
        })
}
