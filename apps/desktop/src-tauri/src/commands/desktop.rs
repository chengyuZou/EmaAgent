use serde::Serialize;
use tauri::Manager;

use crate::desktop::file_dialog::{FileDialogState, SelectPathsOptions};
use crate::desktop::interaction_notifications::{
    InteractionNotificationAction, InteractionNotificationUpdate, InteractionNotifications,
};
use crate::desktop::pet_pointer::PetPointerTracking;
use crate::desktop::windows::{
    begin_stage_focus_settling, set_stage_passthrough, set_stage_passthrough_controls_hovered,
    show_window, stage_passthrough_enabled,
};
use crate::processes::DesktopProcesses;

#[tauri::command]
pub async fn connect_interaction_notifications(
    window: tauri::WebviewWindow,
    notifications: tauri::State<'_, InteractionNotifications>,
    on_action: tauri::ipc::Channel<InteractionNotificationAction>,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("Interaction notifications belong to the main window".into());
    }
    notifications.connect(&window, on_action).await
}

#[tauri::command]
pub async fn sync_interaction_notifications(
    window: tauri::WebviewWindow,
    notifications: tauri::State<'_, InteractionNotifications>,
    update: InteractionNotificationUpdate,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Interaction notifications belong to the main window".into());
    }
    notifications.update(update).await
}

#[tauri::command]
pub async fn select_paths(
    window: tauri::Window,
    state: tauri::State<'_, FileDialogState>,
    options: SelectPathsOptions,
) -> Result<Vec<String>, String> {
    crate::desktop::file_dialog::select_paths(window, &state, options).await
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
pub async fn read_local_image(path: String) -> Result<Vec<u8>, String> {
    // 原生选择和拖放只提供路径. WebView 读取字节后用于预览或上传,
    // 正式图片校验与保存仍由对应的 Server 导入接口处理.
    tokio::fs::read(path)
        .await
        .map_err(|error| error.to_string())
}

#[derive(Serialize)]
pub struct AttachmentPaths {
    files: Vec<String>,
    rejected: Vec<String>,
}

#[tauri::command]
pub async fn inspect_attachment_paths(paths: Vec<String>) -> AttachmentPaths {
    let mut result = AttachmentPaths {
        files: Vec::new(),
        rejected: Vec::new(),
    };
    for path in paths {
        match tokio::fs::metadata(&path).await {
            Ok(metadata) if metadata.is_file() => result.files.push(path),
            _ => result.rejected.push(path),
        }
    }
    result
}
