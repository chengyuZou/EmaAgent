#[cfg(windows)]
use super::webview_media::allow_app_media;
use super::webview_media::SHARED_BROWSER_ARGS;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[tauri::command]
pub async fn open_caption_window(app: AppHandle) -> Result<(), String> {
    // Windows 创建 WebView2 时不能使用同步 command, 避免与原生 UI 线程互相等待.
    let window = match app.get_webview_window("caption") {
        Some(window) => window,
        None => create_caption_window(&app)?,
    };
    window.show().map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

fn create_caption_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    let window = WebviewWindowBuilder::new(app, "caption", WebviewUrl::App("caption.html".into()))
        .title("Ema - 字幕")
        .inner_size(600.0, 180.0)
        .center()
        .visible(false)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .shadow(false)
        .skip_taskbar(true)
        // 与 stage/main 使用相同参数, 否则 Windows 复用 WebView2 环境时可能拒绝创建窗口.
        .additional_browser_args(SHARED_BROWSER_ARGS)
        .build()
        .map_err(|error| format!("failed to create caption webview: {error}"))?;

    #[cfg(windows)]
    allow_app_media(&window)
        .map_err(|error| format!("failed to configure caption media permissions: {error}"))?;

    Ok(window)
}

#[tauri::command]
pub async fn close_caption_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("caption") {
        // 字幕只显示 main 发来的状态, 销毁它不会停止 main 的播放器或后台 TTS.
        window.destroy().map_err(|error| error.to_string())?;
    }
    Ok(())
}
