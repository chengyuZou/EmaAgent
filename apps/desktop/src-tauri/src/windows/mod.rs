pub mod commands;
#[path = "petPointer.rs"]
pub mod pet_pointer;
#[path = "stageInteraction.rs"]
pub mod stage_interaction;
#[path = "webviewMedia.rs"]
pub mod webview_media;

use serde::Serialize;
use stage_interaction::begin_stage_focus_settling;
use tauri::{
    Emitter, EventTarget, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
#[cfg(windows)]
use webview_media::allow_app_media;
use webview_media::SHARED_BROWSER_ARGS;

const WINDOW_VISIBILITY_EVENT: &str = "ema://window-visibility";

#[derive(Clone, Serialize)]
struct WindowVisibilityPayload {
    visible: bool,
}

pub fn destroy_windows_before_exit(app: &tauri::AppHandle, api: &tauri::ExitRequestApi) {
    let windows = app.windows();
    if windows.is_empty() {
        return;
    }

    // 让事件循环继续处理窗口销毁和 WebView 释放, 最后一个窗口销毁后 Tauri 会再次请求退出.
    // destroy 不触发 CloseRequested, 不会被日常关闭按钮的隐藏逻辑拦截.
    api.prevent_exit();
    for (label, window) in windows {
        if let Err(error) = window.destroy() {
            tracing::error!(%label, %error, "failed to destroy window before exit");
        }
    }
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
        "main" => {
            let builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("main.html".into()))
                    .title("Ema")
                    .inner_size(1420.0, 880.0)
                    .min_inner_size(800.0, 600.0)
                    .center()
                    .visible(false)
                    .resizable(true)
                    .decorations(false)
                    .transparent(false)
                    .always_on_top(false)
                    .additional_browser_args(SHARED_BROWSER_ARGS);
            builder
                .build()
                .map_err(|error| format!("failed to create main webview: {error}"))?
        }
        _ => return Err(format!("unknown window label: {label}")),
    };

    #[cfg(windows)]
    allow_app_media(&window)
        .map_err(|error| format!("failed to configure {label} media permissions: {error}"))?;

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

pub fn handle_window_event(window: &tauri::Window, event: &WindowEvent) {
    if window.label() == "main"
        && matches!(event, WindowEvent::Focused(_) | WindowEvent::Resized(_))
    {
        if let Some(notifications) = window
            .app_handle()
            .try_state::<crate::notifications::DesktopNotifications>()
        {
            notifications.refresh();
        }
    }
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
            // 通知所属窗口收起浮动控件或隐藏原生浏览器, 不控制 Live2D 绘制.
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
            if stage_interaction::minimize_unpinned_stage(window) {
                let _ = window.emit_to(
                    EventTarget::window(window.label()),
                    WINDOW_VISIBILITY_EVENT,
                    WindowVisibilityPayload { visible: false },
                );
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
