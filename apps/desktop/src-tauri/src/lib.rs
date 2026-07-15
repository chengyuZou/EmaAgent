mod sidecar;

use tauri::{Manager, RunEvent, WindowEvent};
use tauri::tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState};
use tracing_subscriber::EnvFilter;

use sidecar::SidecarState;

// ── Tauri commands ──────────────────────────────────────────────────────────

#[tauri::command]
fn get_sidecar_secret(state: tauri::State<'_, SidecarState>) -> Result<String, String> {
    state
        .get_secret()
        .map(|s| s.to_string())
        .ok_or_else(|| "sidecar secret not yet available".to_string())
}

#[tauri::command]
async fn get_sidecar_port(state: tauri::State<'_, SidecarState>) -> Result<u16, String> {
    // Block-ish wait for the port — sidecar may not have logged it yet on
    // very first launch. We poll the OnceCell for up to 30s; this matches the
    // frontend's 2s retry loop in src/api/sidecar-status.ts.
    state
        .wait_for_port(std::time::Duration::from_secs(30))
        .await
        .ok_or_else(|| "sidecar port not yet available".to_string())
}

#[tauri::command]
fn set_always_on_top(window: tauri::Window, value: bool) -> Result<(), String> {
    window.set_always_on_top(value).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_passthrough(window: tauri::Window, value: bool) -> Result<(), String> {
    // When passthrough is on, mouse events go through the transparent window
    // to whatever is behind it (desktop / other apps). The character pixels
    // and dock both become non-interactive. Frontend hides the dock when
    // toggling on, otherwise the user has no way to toggle it back off.
    window.set_ignore_cursor_events(value).map_err(|e| e.to_string())
}

#[tauri::command]
async fn quit_app(app: tauri::AppHandle) {
    // F-048 订正:窗口 X 是 prevent_close + hide,不触发 shutdown(见下方
    // on_window_event)。真正退出只有托盘 "quit" 菜单、本 quit_app 命令、
    // 或 RunEvent::Exit 最后防线。这里与托盘 "quit" 走相同的 shutdown + exit,
    // 否则 UI 触发的退出会孤儿掉 sidecar 进程树,SQLite lockfile 指向死 pid。
    let state = app.state::<SidecarState>();
    state.shutdown().await;
    app.exit(0);
}

/// Show + focus a pre-declared sub-window by its label (chat / settings /
/// voice). The window is defined in tauri.conf.json with `visible: false`;
/// this command flips it to visible and brings it forward. Idempotent.
///
/// Returns Err if the label is not in the configured windows list. The frontend
/// surfaces this as a noop with a console warning rather than UI failure.
#[tauri::command]
fn open_window(app: tauri::AppHandle, label: String) -> Result<(), String> {
    use tauri::Manager;

    match app.get_webview_window(&label) {
        Some(window) => {
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
            Ok(())
        }
        None => Err(format!("unknown window label: {label}")),
    }
}

/// 文件元数据 — 供前端附件上传时拿真实 size/mtime。
/// 不引入 tauri-plugin-fs（避免 scope 配置），自定义命令聚焦且无路径白名单限制：
/// 用户已通过 dialog 主动选了文件，读其元数据是合理操作。browser/Ladle 模式前端走 null 兜底。
#[derive(serde::Serialize)]
struct FileMeta {
    size: u64,    // 字节
    mtime: u64,   // unix 毫秒
    is_dir: bool,
}

#[tauri::command]
fn file_metadata(path: String) -> Result<FileMeta, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(FileMeta {
        size: meta.len(),
        mtime,
        is_dir: meta.is_dir(),
    })
}

// ── App entry ───────────────────────────────────────────────────────────────

pub fn run() {
    init_logging();

    let sidecar_state = SidecarState::new();
    let handle_for_setup = sidecar_state.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(sidecar_state)
        .invoke_handler(tauri::generate_handler![
            get_sidecar_secret,
            get_sidecar_port,
            set_always_on_top,
            set_passthrough,
            quit_app,
            open_window,
            file_metadata,
        ])
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let handle = handle_for_setup.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = sidecar::spawn(handle, app_handle).await {
                    tracing::error!(?err, "sidecar spawn failed");
                }
            });

            // ── System tray ────────────────────────────────────────────────
            let tray_menu = tauri::menu::MenuBuilder::new(app)
                .item(&tauri::menu::MenuItem::with_id(app, "show",  "显示 Ema",  true, None::<&str>)?)
                .item(&tauri::menu::MenuItem::with_id(app, "quit",  "退出",       true, None::<&str>)?)
                .build()?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Ema")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    // Left-click: toggle main window visibility
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("main") {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "quit" => {
                        // 不用 block_on 阻塞主线程；spawn 一个 async 任务跑 shutdown 后退出
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let state = app.state::<SidecarState>();
                            state.shutdown().await;
                            app.exit(0);
                        });
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // All windows (main included) hide to tray instead of closing.
                // The only way to fully quit is via the tray menu "退出".
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                // 最后防线：任何退出路径（崩溃、Task Manager 杀、系统关机）都尝试清理。
                // 配合 Job Object，即使 shutdown 没跑完，OS 也会 kill 整个 Job（bug 4 兜底）。
                let state = app_handle.state::<SidecarState>();
                tauri::async_runtime::block_on(async {
                    state.shutdown().await;
                });
                tracing::info!("tauri exit event — sidecar + bridge shutdown complete");
            }
        });
}

fn init_logging() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,ema_desktop_lib=debug"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .init();
}
