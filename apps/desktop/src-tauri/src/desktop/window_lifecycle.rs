// 统一处理桌面窗口显示、隐藏和前端可见性通知。
use serde::Serialize;
use tauri::{Emitter, Manager, WindowEvent};

const WINDOW_VISIBILITY_EVENT: &str = "ema://window-visibility";

#[derive(Clone, Serialize)]
struct WindowVisibilityPayload {
    visible: bool,
}

pub fn show_window(app: &tauri::AppHandle, label: &str) -> Result<(), String> {
    let window = app
        .get_webview_window(label)
        .ok_or_else(|| format!("unknown window label: {label}"))?;
    window.show().map_err(|error| error.to_string())?;
    emit_visibility(&window, true);
    window.set_focus().map_err(|error| error.to_string())
}

pub fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        emit_visibility(&window, true);
        let _ = window.set_focus();
    }
}

pub fn toggle_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
            emit_visibility(&window, false);
        } else {
            let _ = window.show();
            emit_visibility(&window, true);
            let _ = window.set_focus();
        }
    }
}

pub fn handle_window_event(window: &tauri::Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = window.hide();
        let _ = window.emit(
            WINDOW_VISIBILITY_EVENT,
            WindowVisibilityPayload { visible: false },
        );
    }
}

fn emit_visibility(window: &tauri::WebviewWindow, visible: bool) {
    let _ = window.emit(WINDOW_VISIBILITY_EVENT, WindowVisibilityPayload { visible });
}
