// 统一处理桌面窗口的惰性创建、显示、隐藏和前端可见性通知。
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{
    Emitter, EventTarget, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

const WINDOW_VISIBILITY_EVENT: &str = "ema://window-visibility";
const MAIN_PASSTHROUGH_EVENT: &str = "ema://pet-passthrough";
// 同一进程内的 WebView2 必须使用一致的浏览器参数，否则后创建的窗口会被环境复用规则拒绝。
pub(crate) const SHARED_BROWSER_ARGS: &str = "--autoplay-policy=no-user-gesture-required";
const MAIN_FOCUS_SETTLE_GRACE: Duration = Duration::from_millis(350);
static MAIN_FOCUSED_AT: Mutex<Option<Instant>> = Mutex::new(None);
// 控制区可临时接收点击, 但仍处于穿透模式, 不能恢复失焦自动最小化.
static MAIN_PASSTHROUGH_ENABLED: AtomicBool = AtomicBool::new(false);

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
    // 显示不等于解除最小化, 必须先恢复窗口再请求前台焦点.
    window.unminimize().map_err(|error| error.to_string())?;
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
            .resizable(false)
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
            .inner_size(1420.0, 880.0)
            .min_inner_size(800.0, 600.0)
            .center()
            .visible(false)
            .resizable(true)
            .decorations(true)
            .transparent(false)
            .always_on_top(false)
            .disable_drag_drop_handler()
            .additional_browser_args(SHARED_BROWSER_ARGS)
            .build()
            .map_err(|error| format!("failed to create chat webview: {error}"))?,
        "settings" => {
            WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
                .title("Ema · 设置")
                .inner_size(1420.0, 880.0)
                .min_inner_size(720.0, 560.0)
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

pub fn main_passthrough_enabled() -> bool {
    MAIN_PASSTHROUGH_ENABLED.load(Ordering::SeqCst)
}

pub fn set_main_passthrough(window: &WebviewWindow, enabled: bool) -> Result<(), String> {
    if window.label() != "main" {
        return Err("click passthrough is only available for the pet window".into());
    }

    if !enabled {
        begin_main_focus_settling();
    }
    let previous = MAIN_PASSTHROUGH_ENABLED.swap(enabled, Ordering::SeqCst);
    if let Err(error) = window.set_ignore_cursor_events(enabled) {
        MAIN_PASSTHROUGH_ENABLED.store(previous, Ordering::SeqCst);
        return Err(error.to_string());
    }
    window
        .emit_to(EventTarget::window("main"), MAIN_PASSTHROUGH_EVENT, enabled)
        .map_err(|error| error.to_string())
}

pub fn set_main_passthrough_controls_hovered(
    window: &WebviewWindow,
    hovered: bool,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("click passthrough is only available for the pet window".into());
    }
    // 托盘可能已关闭模式. 迟到的鼠标坐标更新不得重新开启原生穿透.
    window
        .set_ignore_cursor_events(main_passthrough_enabled() && !hovered)
        .map_err(|error| error.to_string())
}

pub fn handle_window_event(window: &tauri::Window, event: &WindowEvent) {
    // Tauri 的 emit 会广播到所有窗口;可见性必须按 label 定向,否则关闭子窗口会暂停 main 舞台。
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = window.hide();
            let _ = window.emit_to(
                EventTarget::window(window.label()),
                WINDOW_VISIBILITY_EVENT,
                WindowVisibilityPayload { visible: false },
            );
        }
        WindowEvent::Focused(true) if window.label() == "main" => {
            begin_main_focus_settling();
            let _ = window.emit_to(
                EventTarget::window(window.label()),
                WINDOW_VISIBILITY_EVENT,
                WindowVisibilityPayload { visible: true },
            );
        }
        WindowEvent::Resized(_) if window.label() == "main" => {
            // 任务栏最小化先改变原生窗口尺寸,随后 WebView 停止投递动画帧;恢复时顺序相反。
            // 必须在这个边沿广播真实最小化状态,否则前端一直保持 visible=true,ticker 没有重启机会。
            if let Ok(minimized) = window.is_minimized() {
                let _ = window.emit_to(
                    EventTarget::window(window.label()),
                    WINDOW_VISIBILITY_EVENT,
                    WindowVisibilityPayload {
                        visible: !minimized,
                    },
                );
            }
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
            if focus_is_stable
                && !main_passthrough_enabled()
                && matches!(window.is_always_on_top(), Ok(false))
            {
                if let Err(error) = window.minimize() {
                    tracing::warn!(%error, "failed to minimize unpinned main window");
                } else {
                    let _ = window.emit_to(
                        EventTarget::window(window.label()),
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
    let _ = window.emit_to(
        EventTarget::window(window.label()),
        WINDOW_VISIBILITY_EVENT,
        WindowVisibilityPayload { visible },
    );
}
