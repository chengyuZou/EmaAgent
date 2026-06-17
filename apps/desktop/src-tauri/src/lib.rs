mod sidecar;

use tauri::{Manager, RunEvent, WindowEvent};
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
    // Same cleanup as the main window's CloseRequested handler — without this,
    // a UI-triggered quit (tray menu, settings "Exit" button, etc.) orphans
    // the sidecar process tree and leaves the SQLite lockfile pointing at a
    // dead-but-still-running pid.
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

// ── App entry ───────────────────────────────────────────────────────────────

pub fn run() {
    init_logging();

    let sidecar_state = SidecarState::new();
    let handle_for_setup = sidecar_state.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(sidecar_state)
        .invoke_handler(tauri::generate_handler![
            get_sidecar_secret,
            get_sidecar_port,
            set_always_on_top,
            set_passthrough,
            quit_app,
            open_window,
        ])
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let handle = handle_for_setup.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = sidecar::spawn(handle, app_handle).await {
                    tracing::error!(?err, "sidecar spawn failed");
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                match window.label() {
                    "main" => {
                        let state = window.state::<SidecarState>();
                        tauri::async_runtime::block_on(async {
                            state.shutdown().await;
                        });
                    }
                    // Sub-windows are pre-declared singletons — destroying them
                    // would make open_window fail forever. Hide instead.
                    _ => {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            if let RunEvent::Exit = event {
                tracing::info!("tauri exit event");
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
