#[path = "appLifecycle.rs"]
mod app_lifecycle;
mod browser;
mod files;
mod fonts;
mod logging;
mod notifications;
#[path = "profilePath.rs"]
mod profile_path;
mod server;
mod terminal;
mod tray;
mod windows;

use app_lifecycle::quit_app;
use browser::commands::*;
use files::{inspect_attachment_paths, open_path, read_local_image, select_paths};
use fonts::list_system_fonts;
use notifications::commands::*;
use server::commands::*;
use server::ServerProcess;
use terminal::{commands::*, TerminalSessions};
use windows::pet_pointer::PetPointerTracking;
use windows::{commands::*, handle_window_event, show_stage_window};

pub fn run() {
    logging::init_logging();

    let server = ServerProcess::new().expect("failed to initialize Server process");

    tauri::Builder::default()
        // 第二实例只显示已有角色舞台, 不重复启动后端进程.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_stage_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(server)
        .manage(files::file_dialog::FileDialogState::default())
        .manage(TerminalSessions::new())
        .manage(PetPointerTracking::default())
        .invoke_handler(tauri::generate_handler![
            connect_desktop_notifications,
            sync_interaction_notifications,
            show_session_completion,
            select_paths,
            inspect_attachment_paths,
            get_server_secret,
            get_server_port,
            list_system_fonts,
            set_always_on_top,
            set_passthrough,
            get_passthrough,
            start_pet_pointer,
            set_passthrough_controls_hovered,
            quit_app,
            open_main_window,
            hide_main_window,
            open_path,
            read_local_image,
            open_terminal,
            write_terminal,
            resize_terminal,
            close_terminal,
            close_session_terminals,
            open_browser,
            navigate_browser,
            browser_back,
            browser_forward,
            reload_browser,
            set_browser_bounds,
            set_browser_visible,
            close_browser,
        ])
        .setup(app_lifecycle::setup)
        .on_window_event(handle_window_event)
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(app_lifecycle::handle_run_event);
}
