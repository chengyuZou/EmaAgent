// 组装 Tauri 插件、桌面能力、共享状态和应用生命周期。
mod commands;
mod credential_key;
mod desktop;
mod file_access;
mod runtime;

use tauri::{Manager, RunEvent};
use tracing_subscriber::EnvFilter;

use commands::{
    get_runtime_snapshot, get_sidecar_port, get_sidecar_secret, open_window, quit_app,
    set_always_on_top, set_passthrough,
};
use desktop::window_lifecycle::{handle_window_event, show_main_window};
use file_access::{
    open_authorized_file, pick_authorized_directory, pick_authorized_files, FileAccessFacade,
};
use runtime::DesktopRuntimeSupervisor;

pub fn run() {
    init_logging();

    let credential_master_key = credential_key::load_or_create_master_key()
        .expect("failed to initialize OS-protected desktop master key");
    let runtime = DesktopRuntimeSupervisor::new(credential_master_key.clone())
        .expect("failed to initialize desktop runtime supervisor");
    let file_access = FileAccessFacade::new(&credential_master_key)
        .expect("failed to initialize local file access facade");
    let runtime_for_setup = runtime.clone();

    tauri::Builder::default()
        // 单实例插件在 setup 前取得所有权，第二实例只能唤醒主窗口。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(runtime)
        .manage(file_access)
        .invoke_handler(tauri::generate_handler![
            get_sidecar_secret,
            get_sidecar_port,
            get_runtime_snapshot,
            set_always_on_top,
            set_passthrough,
            quit_app,
            open_window,
            pick_authorized_files,
            pick_authorized_directory,
            open_authorized_file,
        ])
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let supervisor = runtime_for_setup.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = supervisor.start(app_handle).await {
                    tracing::error!(%error, "desktop runtime startup failed");
                }
            });

            desktop::tray::install(app)?;

            // 主窗必须在首次启动时出现；聊天与设置仍由用户操作时惰性创建。
            show_main_window(app.handle());
            Ok(())
        })
        .on_window_event(handle_window_event)
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                // 最后防线负责回收异常退出路径遗留的整棵 Sidecar 进程树。
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
