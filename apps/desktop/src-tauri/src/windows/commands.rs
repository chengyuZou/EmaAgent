use super::pet_pointer::PetPointerTracking;
use super::show_window;
use super::stage_interaction::{
    begin_stage_focus_settling, set_stage_passthrough, set_stage_passthrough_controls_hovered,
    stage_passthrough_enabled,
};

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
pub async fn open_main_window(app: tauri::AppHandle) -> Result<(), String> {
    // Windows 同步 command 创建 WebView2 会与 UI 线程互等, 必须由异步线程请求创建.
    show_window(&app, "main").map_err(|error| {
        tracing::error!(%error, "open_main_window failed");
        error
    })
}

#[tauri::command]
pub fn hide_main_window(app: tauri::AppHandle) -> Result<(), String> {
    crate::windows::hide_main_window(&app)
}
