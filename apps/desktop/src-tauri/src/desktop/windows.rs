// 统一处理桌面窗口的惰性创建、显示、隐藏和前端可见性通知。
use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

const WINDOW_VISIBILITY_EVENT: &str = "ema://window-visibility";
// 同一进程内的 WebView2 必须使用一致的浏览器参数，否则后创建的窗口会被环境复用规则拒绝。
const SHARED_BROWSER_ARGS: &str = "--autoplay-policy=no-user-gesture-required";
const MAIN_FOCUS_SETTLE_GRACE: Duration = Duration::from_millis(350);
static MAIN_FOCUSED_AT: Mutex<Option<Instant>> = Mutex::new(None);

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

pub fn begin_main_focus_settling() {
    if let Ok(mut focused_at) = MAIN_FOCUSED_AT.lock() {
        *focused_at = Some(Instant::now());
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
        WindowEvent::Focused(true) if window.label() == "main" => {
            begin_main_focus_settling();
            let _ = window.emit(
                WINDOW_VISIBILITY_EVENT,
                WindowVisibilityPayload { visible: true },
            );
        }
        // Windows 从任务栏恢复窗口时可能紧跟一次瞬时失焦；稳定窗口内不执行自动最小化。
        WindowEvent::Focused(false) if window.label() == "main" => {
            let focus_is_stable = MAIN_FOCUSED_AT
                .lock()
                .ok()
                .and_then(|focused_at| *focused_at)
                .map_or(true, |focused_at| {
                    focused_at.elapsed() >= MAIN_FOCUS_SETTLE_GRACE
                });
            if focus_is_stable && matches!(window.is_always_on_top(), Ok(false)) {
                if let Err(error) = window.minimize() {
                    tracing::warn!(%error, "failed to minimize unpinned main window");
                } else {
                    let _ = window.emit(
                        WINDOW_VISIBILITY_EVENT,
                        WindowVisibilityPayload { visible: false },
                    );
                }
            }
        }
        _ => {}
    }
}

fn emit_visibility(window: &tauri::WebviewWindow, visible: bool) {
    let _ = window.emit(WINDOW_VISIBILITY_EVENT, WindowVisibilityPayload { visible });
}
