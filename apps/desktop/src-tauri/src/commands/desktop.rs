// 提供主窗口显示, 舞台交互模式与应用退出命令.
use serde::Deserialize;
use tauri::Manager;

use crate::desktop::pet_pointer::PetPointerTracking;
use crate::desktop::windows::{
    begin_stage_focus_settling, set_stage_passthrough, set_stage_passthrough_controls_hovered,
    show_window, stage_passthrough_enabled,
};
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
    if window.label() == "stage" && !value {
        begin_stage_focus_settling();
    }
    Ok(())
}

#[tauri::command]
pub fn set_passthrough(window: tauri::WebviewWindow, value: bool) -> Result<(), String> {
    set_stage_passthrough(&window, value)
}

#[tauri::command]
pub fn get_passthrough() -> bool {
    stage_passthrough_enabled()
}

#[tauri::command]
pub fn start_pet_pointer(
    window: tauri::WebviewWindow,
    tracking: tauri::State<'_, PetPointerTracking>,
) -> Result<(), String> {
    tracking.start(window)
}

#[tauri::command]
pub fn set_passthrough_controls_hovered(
    window: tauri::WebviewWindow,
    hovered: bool,
) -> Result<(), String> {
    set_stage_passthrough_controls_hovered(&window, hovered)
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
pub async fn open_main_window(app: tauri::AppHandle) -> Result<(), String> {
    // Windows 同步 command 创建 WebView2 会与 UI 线程互等, 必须由异步线程请求创建.
    show_window(&app, "main").map_err(|error| {
        tracing::error!(%error, "open_main_window failed");
        error
    })
}

#[tauri::command]
pub fn hide_main_window(app: tauri::AppHandle) -> Result<(), String> {
    crate::desktop::windows::hide_main_window(&app)
}

#[tauri::command]
pub fn open_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    // 用宿主侧 opener 打开路径本身, 自有 command 不经 WebView ACL.
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(&path, None::<&str>)
        .map_err(|error| {
            tracing::warn!(%path, %error, "open_path failed");
            error.to_string()
        })
}

#[tauri::command]
pub async fn read_draft_image(path: String) -> Result<Vec<u8>, String> {
    // 文件选择器只返回路径, WebView 无法直接显示本机文件. 这里仅为草稿预览读取字节,
    // 不创建 Session 附件; 点击发送后仍由原有上传接口负责正式落盘.
    tokio::fs::read(path)
        .await
        .map_err(|error| error.to_string())
}
