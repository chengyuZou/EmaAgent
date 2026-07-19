// 组装 Tauri 桌面宿主、窗口生命周期、托盘与 Sidecar 进程管理。
mod credential_key;
mod runtime;

use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tracing_subscriber::EnvFilter;

use runtime::{DesktopRuntimeSupervisor, RuntimeSnapshot};

const WINDOW_VISIBILITY_EVENT: &str = "ema://window-visibility";

#[derive(Clone, serde::Serialize)]
struct WindowVisibilityPayload {
    visible: bool,
}

// ── Tauri commands ──────────────────────────────────────────────────────────

#[tauri::command]
async fn get_sidecar_secret(
    state: tauri::State<'_, DesktopRuntimeSupervisor>,
) -> Result<String, String> {
    state
        .get_secret()
        .await
        .ok_or_else(|| "sidecar secret not yet available".to_string())
}

#[tauri::command]
async fn get_sidecar_port(
    state: tauri::State<'_, DesktopRuntimeSupervisor>,
) -> Result<u16, String> {
    state
        .wait_for_port(std::time::Duration::from_secs(30))
        .await
        .ok_or_else(|| "sidecar port not yet available".to_string())
}

#[tauri::command]
async fn get_runtime_snapshot(
    state: tauri::State<'_, DesktopRuntimeSupervisor>,
) -> Result<RuntimeSnapshot, String> {
    Ok(state.snapshot().await)
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
    window
        .set_ignore_cursor_events(value)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn quit_app(app: tauri::AppHandle) {
    // F-048 订正:窗口 X 是 prevent_close + hide,不触发 shutdown(见下方
    // on_window_event)。真正退出只有托盘 "quit" 菜单、本 quit_app 命令、
    // 或 RunEvent::Exit 最后防线。这里与托盘 "quit" 走相同的 shutdown + exit,
    // 否则 UI 触发的退出会孤儿掉 sidecar 进程树,SQLite lockfile 指向死 pid。
    let state = app.state::<DesktopRuntimeSupervisor>();
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
            let _ = window.emit(
                WINDOW_VISIBILITY_EVENT,
                WindowVisibilityPayload { visible: true },
            );
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
    size: u64,  // 字节
    mtime: u64, // unix 毫秒
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

    let runtime =
        DesktopRuntimeSupervisor::new().expect("failed to initialize desktop runtime supervisor");
    let runtime_for_setup = runtime.clone();

    tauri::Builder::default()
        // 单实例在 setup 之前取得所有权，第二个 Host 只能唤醒现有主窗口，
        // 不能启动另一套 Core/Bridge 或接触同一数据库。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.emit(
                    WINDOW_VISIBILITY_EVENT,
                    WindowVisibilityPayload { visible: true },
                );
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(runtime)
        .invoke_handler(tauri::generate_handler![
            get_sidecar_secret,
            get_sidecar_port,
            get_runtime_snapshot,
            set_always_on_top,
            set_passthrough,
            quit_app,
            open_window,
            file_metadata,
        ])
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let supervisor = runtime_for_setup.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = supervisor.start(app_handle).await {
                    tracing::error!(%error, "desktop runtime startup failed");
                }
            });

            // ── System tray ────────────────────────────────────────────────
            let tray_menu = tauri::menu::MenuBuilder::new(app)
                .item(&tauri::menu::MenuItem::with_id(
                    app,
                    "show",
                    "显示 Ema",
                    true,
                    None::<&str>,
                )?)
                .item(&tauri::menu::MenuItem::with_id(
                    app,
                    "quit",
                    "退出",
                    true,
                    None::<&str>,
                )?)
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
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("main") {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                                let _ = win.emit(
                                    WINDOW_VISIBILITY_EVENT,
                                    WindowVisibilityPayload { visible: false },
                                );
                            } else {
                                let _ = win.show();
                                let _ = win.emit(
                                    WINDOW_VISIBILITY_EVENT,
                                    WindowVisibilityPayload { visible: true },
                                );
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.emit(
                                WINDOW_VISIBILITY_EVENT,
                                WindowVisibilityPayload { visible: true },
                            );
                            let _ = win.set_focus();
                        }
                    }
                    "quit" => {
                        // 不用 block_on 阻塞主线程；spawn 一个 async 任务跑 shutdown 后退出
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let state = app.state::<DesktopRuntimeSupervisor>();
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
                let _ = window.emit(
                    WINDOW_VISIBILITY_EVENT,
                    WindowVisibilityPayload { visible: false },
                );
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                // 最后防线：正常 Tauri 退出路径都尝试清理。Windows Job Object
                // 和 Unix process group 负责进程异常退出时的整棵进程树兜底。
                let state = app_handle.state::<DesktopRuntimeSupervisor>();
                tauri::async_runtime::block_on(async {
                    state.shutdown().await;
                });
                tracing::info!("tauri exit event — desktop runtime shutdown complete");
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
