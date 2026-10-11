// stage 首次启动时显示, main 按需创建; 隐藏窗口不销毁 WebView.
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{
    Emitter, EventTarget, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

const WINDOW_VISIBILITY_EVENT: &str = "ema://window-visibility";
const STAGE_PASSTHROUGH_EVENT: &str = "ema://pet-passthrough";
// 同一进程内的 WebView2 必须使用一致的浏览器参数, 否则后创建的窗口会被环境复用规则拒绝.
pub(crate) const SHARED_BROWSER_ARGS: &str = "--autoplay-policy=no-user-gesture-required";
const STAGE_FOCUS_SETTLE_GRACE: Duration = Duration::from_millis(350);
static STAGE_FOCUSED_AT: Mutex<Option<Instant>> = Mutex::new(None);
// 控制区可临时接收点击, 但仍处于穿透模式, 不能恢复失焦自动最小化.
static STAGE_PASSTHROUGH_ENABLED: AtomicBool = AtomicBool::new(false);

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
        "stage" => WebviewWindowBuilder::new(app, "stage", WebviewUrl::App("index.html".into()))
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
            .map_err(|error| format!("failed to create stage webview: {error}"))?,
        "main" => WebviewWindowBuilder::new(app, "main", WebviewUrl::App("main.html".into()))
            .title("Ema")
            .inner_size(1420.0, 880.0)
            .min_inner_size(800.0, 600.0)
            .center()
            .visible(false)
            .resizable(true)
            .decorations(false)
            .transparent(false)
            .always_on_top(false)
            .disable_drag_drop_handler()
            .additional_browser_args(SHARED_BROWSER_ARGS)
            .build()
            .map_err(|error| format!("failed to create main webview: {error}"))?,
        _ => return Err(format!("unknown window label: {label}")),
    };

    Ok(window)
}

pub fn show_stage_window(app: &tauri::AppHandle) {
    if let Err(error) = show_window(app, "stage") {
        tracing::error!(%error, "failed to show stage window");
    }
}

pub fn toggle_stage_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("stage") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
            emit_visibility(&window, false);
        } else {
            show_stage_window(app);
        }
    }
}

pub fn hide_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is not open".to_string())?;
    window.hide().map_err(|error| error.to_string())?;
    emit_visibility(&window, false);
    Ok(())
}

pub fn begin_stage_focus_settling() {
    if let Ok(mut focused_at) = STAGE_FOCUSED_AT.lock() {
        *focused_at = Some(Instant::now());
    }
}

pub fn stage_passthrough_enabled() -> bool {
    STAGE_PASSTHROUGH_ENABLED.load(Ordering::SeqCst)
}

pub fn set_stage_passthrough(window: &WebviewWindow, enabled: bool) -> Result<(), String> {
    if window.label() != "stage" {
        return Err("click passthrough is only available for the pet window".into());
    }

    if !enabled {
        begin_stage_focus_settling();
    }
    let previous = STAGE_PASSTHROUGH_ENABLED.swap(enabled, Ordering::SeqCst);
    if let Err(error) = window.set_ignore_cursor_events(enabled) {
        STAGE_PASSTHROUGH_ENABLED.store(previous, Ordering::SeqCst);
        return Err(error.to_string());
    }
    window
        .emit_to(
            EventTarget::window("stage"),
            STAGE_PASSTHROUGH_EVENT,
            enabled,
        )
        .map_err(|error| error.to_string())
}

pub fn set_stage_passthrough_controls_hovered(
    window: &WebviewWindow,
    hovered: bool,
) -> Result<(), String> {
    if window.label() != "stage" {
        return Err("click passthrough is only available for the pet window".into());
    }
    // 托盘可能已关闭模式. 迟到的鼠标坐标更新不得重新开启原生穿透.
    window
        .set_ignore_cursor_events(stage_passthrough_enabled() && !hovered)
        .map_err(|error| error.to_string())
}

pub fn handle_window_event(window: &tauri::Window, event: &WindowEvent) {
    // 可见性通知只发给所属窗口, main 的隐藏不能暂停 stage 动画.
    match event {
        // 保留两个 WebView, 已提交操作和会话订阅不随窗口隐藏停止.
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = window.hide();
            let _ = window.emit_to(
                EventTarget::window(window.label()),
                WINDOW_VISIBILITY_EVENT,
                WindowVisibilityPayload { visible: false },
            );
        }
        WindowEvent::Focused(true) => {
            if window.label() == "stage" {
                begin_stage_focus_settling();
            }
            let _ = window.emit_to(
                EventTarget::window(window.label()),
                WINDOW_VISIBILITY_EVENT,
                WindowVisibilityPayload { visible: true },
            );
        }
        WindowEvent::Resized(_) => {
            // 最小化前通知 stage 动画与 main 原生浏览器隐藏, 恢复后按真实状态显示.
            if let (Ok(visible), Ok(minimized)) = (window.is_visible(), window.is_minimized()) {
                let _ = window.emit_to(
                    EventTarget::window(window.label()),
                    WINDOW_VISIBILITY_EVENT,
                    WindowVisibilityPayload {
                        visible: visible && !minimized,
                    },
                );
            }
        }
        // Windows 从任务栏恢复舞台时可能瞬时失焦, 等焦点稳定后才允许自动最小化.
        WindowEvent::Focused(false) if window.label() == "stage" => {
            let focus_is_stable = STAGE_FOCUSED_AT
                .lock()
                .ok()
                .and_then(|focused_at| *focused_at)
                .map_or(true, |focused_at| {
                    focused_at.elapsed() >= STAGE_FOCUS_SETTLE_GRACE
                });
            if focus_is_stable
                && !stage_passthrough_enabled()
                && matches!(window.is_always_on_top(), Ok(false))
            {
                if let Err(error) = window.minimize() {
                    tracing::warn!(%error, "failed to minimize unpinned stage window");
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
