mod sidecar;

use tauri::{Manager, RunEvent, WindowEvent};
use tracing_subscriber::EnvFilter;

use sidecar::SidecarState;

// ── Tauri commands ──────────────────────────────────────────────────────────

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

// ── App entry ───────────────────────────────────────────────────────────────

pub fn run() {
    init_logging();

    let sidecar_state = SidecarState::new();
    let handle_for_setup = sidecar_state.clone();

    tauri::Builder::default()
        .manage(sidecar_state)
        .invoke_handler(tauri::generate_handler![get_sidecar_port])
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
            if let WindowEvent::CloseRequested { .. } = event {
                if window.label() == "main" {
                    let state = window.state::<SidecarState>();
                    tauri::async_runtime::block_on(async {
                        state.shutdown().await;
                    });
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
