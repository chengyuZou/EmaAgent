// 统一处理桌面窗口的惰性创建、显示、隐藏和前端可见性通知。
use serde::Serialize;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

use crate::file_access::{install_authorized_drop_handler, FileAccessFacade};

const WINDOW_VISIBILITY_EVENT: &str = "ema://window-visibility";
// 同一进程内的 WebView2 必须使用一致的浏览器参数，否则后创建的窗口会被环境复用规则拒绝。
const SHARED_BROWSER_ARGS: &str = "--autoplay-policy=no-user-gesture-required";

#[derive(Clone, Serialize)]
struct WindowVisibilityPayload {
    visible: bool,
}

pub fn show_window(app: &tauri::AppHandle, label: &str) -> Result<(), String> {
    let window = match app.get_webview_window(label) {
        Some(window) => window,
        None => create_window(app, label)?,
    };
    window.show().map_err(|error| error.to_string())?;
    emit_visibility(&window, true);
    window.set_focus().map_err(|error| error.to_string())
}

fn create_window(app: &tauri::AppHandle, label: &str) -> Result<WebviewWindow, String> {
    let window = match label {
        "main" => WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
            .title("Ema")
            .inner_size(400.0, 720.0)
            .center()
            .visible(false)
            .resizable(true)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .shadow(false)
            .skip_taskbar(false)
            .additional_browser_args(SHARED_BROWSER_ARGS)
            .build()
            .map_err(|error| format!("failed to create main webview: {error}"))?,
        "chat" => WebviewWindowBuilder::new(app, "chat", WebviewUrl::App("chat.html".into()))
            .title("Ema · 聊天")
            .inner_size(720.0, 560.0)
            .center()
            .visible(false)
            .resizable(true)
            .decorations(true)
            .transparent(false)
            .always_on_top(false)
            .additional_browser_args(SHARED_BROWSER_ARGS)
            .build()
            .map_err(|error| format!("failed to create chat webview: {error}"))?,
        "settings" => {
            WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
                .title("Ema · 设置")
                .inner_size(860.0, 620.0)
                .center()
                .visible(false)
                .resizable(true)
                .decorations(true)
                .transparent(false)
                .always_on_top(false)
                .additional_browser_args(SHARED_BROWSER_ARGS)
                .build()
                .map_err(|error| format!("failed to create settings webview: {error}"))?
        }
        _ => return Err(format!("unknown window label: {label}")),
    };

    // 聊天窗首次出现时才获得拖拽文件授权；隐藏后复用同一窗口，不重复注册处理器。
    if label == "chat" {
        let file_access = app.state::<FileAccessFacade>().inner().clone();
        install_authorized_drop_handler(&window, file_access);
    }

    Ok(window)
}

pub fn show_main_window(app: &tauri::AppHandle) {
    if let Err(error) = show_window(app, "main") {
        tracing::error!(%error, "failed to show main window");
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
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = window.hide();
            let _ = window.emit(
                WINDOW_VISIBILITY_EVENT,
                WindowVisibilityPayload { visible: false },
            );
        }
        // 主窗取消置顶后采用普通桌宠语义：用户切到其他应用时自动最小化，
        // 避免透明无边框窗口留在桌面中间却没有原生最小化按钮。
        WindowEvent::Focused(false) if window.label() == "main" => {
            if matches!(window.is_always_on_top(), Ok(false)) {
                if let Err(error) = window.minimize() {
                    tracing::warn!(%error, "failed to minimize unpinned main window");
                }
            }
        }
        _ => {}
    }
}

fn emit_visibility(window: &tauri::WebviewWindow, visible: bool) {
    let _ = window.emit(WINDOW_VISIBILITY_EVENT, WindowVisibilityPayload { visible });
}
