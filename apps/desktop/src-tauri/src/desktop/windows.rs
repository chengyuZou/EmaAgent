// stage 首次启动时显示, main 按需创建; 隐藏窗口不销毁 WebView.
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{
    Emitter, EventTarget, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
#[cfg(windows)]
use webview2_com::{
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Profile4, ICoreWebView2_13, COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY,
        COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    },
    SetPermissionStateCompletedHandler,
};
#[cfg(windows)]
use windows_core::{Interface, PCWSTR};

const WINDOW_VISIBILITY_EVENT: &str = "ema://window-visibility";
const STAGE_PASSTHROUGH_EVENT: &str = "ema://pet-passthrough";
#[cfg(windows)]
const PACKAGED_APP_ORIGIN: &str = "http://tauri.localhost";
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

#[cfg(windows)]
pub fn allow_app_media(window: &WebviewWindow) -> tauri::Result<()> {
    // 窗口刚创建时仍可能是 about:blank, 不能用当前页面 URL 决定授权地址.
    // 开发版读取 devUrl, 正式版的 stage/main 使用 Tauri 默认的 http 本地资源协议.
    let configured_origin = if tauri::is_dev() {
        window
            .app_handle()
            .config()
            .build
            .dev_url
            .as_ref()
            .map(|url| url.origin().ascii_serialization())
    } else {
        None
    };
    let origin = configured_origin.unwrap_or_else(|| PACKAGED_APP_ORIGIN.to_owned());

    // 只在自有窗口创建时调用, 不为外部浏览器子视图授权.
    window.with_webview(move |webview| {
        // with_webview 在原生 UI 线程执行, COM 接口不能移到异步任务里调用.
        let profile = unsafe {
            webview
                .controller()
                .CoreWebView2()
                .and_then(|webview| webview.cast::<ICoreWebView2_13>())
                .and_then(|webview| webview.Profile())
                .and_then(|profile| profile.cast::<ICoreWebView2Profile4>())
        };
        let profile = match profile {
            Ok(profile) => profile,
            Err(error) => {
                tracing::error!(%error, %origin, "failed to access WebView2 media permissions");
                return;
            }
        };
        let origin_utf16: Vec<u16> = origin.encode_utf16().chain(std::iter::once(0)).collect();

        // 直接把本应用在 profile 中已保存的拒绝状态改为允许.
        for (kind, permission) in [
            (COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, "microphone"),
            (COREWEBVIEW2_PERMISSION_KIND_CAMERA, "camera"),
            (COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY, "autoplay"),
        ] {
            let permission_origin = origin.clone();
            let completed = SetPermissionStateCompletedHandler::create(Box::new(move |result| {
                if let Err(error) = result {
                    tracing::error!(
                        %error,
                        origin = %permission_origin,
                        permission,
                        "failed to allow app media permission"
                    );
                }
                Ok(())
            }));
            if let Err(error) = unsafe {
                profile.SetPermissionState(
                    kind,
                    PCWSTR(origin_utf16.as_ptr()),
                    COREWEBVIEW2_PERMISSION_STATE_ALLOW,
                    &completed,
                )
            } {
                tracing::error!(%error, %origin, permission, "failed to set app media permission");
            }
        }
    })
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
    if window.label() == "main"
        && matches!(event, WindowEvent::Focused(_) | WindowEvent::Resized(_))
    {
        if let Some(notifications) = window
            .app_handle()
            .try_state::<super::interaction_notifications::InteractionNotifications>(
        ) {
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
