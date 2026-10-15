// 组装 Tauri 插件 桌面能力 共享状态和应用生命周期
mod bundled_data;
mod commands;
mod desktop;
mod logging;
mod processes;

use tauri::{Manager, RunEvent};

use commands::{
    browser_back, browser_forward, close_browser, close_session_terminals, close_terminal,
    get_passthrough, get_server_port, get_server_secret, hide_main_window, list_system_fonts,
    navigate_browser, open_browser, open_main_window, open_path, open_terminal, quit_app,
    read_draft_image, reload_browser, report_live2d_diagnostic, resize_terminal, set_always_on_top,
    set_browser_bounds, set_browser_visible, set_passthrough, set_passthrough_controls_hovered,
    start_pet_pointer, write_terminal,
};
use desktop::pet_pointer::PetPointerTracking;
use desktop::terminal::TerminalSessions;
use desktop::windows::{destroy_windows_before_exit, handle_window_event, show_stage_window};
use processes::DesktopProcesses;

pub fn run() {
    logging::init_logging();

    let processes = DesktopProcesses::new().expect("failed to initialize desktop child processes");
    let processes_for_setup = processes.clone();

    tauri::Builder::default()
        // 第二实例只显示已有角色舞台, 不重复启动后端进程.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_stage_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(processes)
        .manage(TerminalSessions::new())
        .manage(PetPointerTracking::default())
        .invoke_handler(tauri::generate_handler![
            get_server_secret,
            get_server_port,
            report_live2d_diagnostic,
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
            read_draft_image,
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
        .setup(move |app| {
            #[cfg(windows)]
            if let Some(stage) = app.get_webview_window("stage") {
                desktop::windows::allow_app_media(&stage)?;
            }

            let app_handle = app.handle().clone();
            let processes = processes_for_setup.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = processes.start(app_handle).await {
                    tracing::error!(%error, "desktop child process startup failed");
                }
            });

            desktop::tray::install(app)?;

            // 首次启动显示角色舞台, 用户点击舞台按钮后才创建 main.
            show_stage_window(app.handle());
            Ok(())
        })
        .on_window_event(handle_window_event)
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::ExitRequested { api, .. } = &event {
                app_handle.state::<PetPointerTracking>().stop();
                destroy_windows_before_exit(app_handle, api);
            }
            if let RunEvent::Exit = event {
                app_handle.state::<PetPointerTracking>().stop();
                // 退出时回收子进程树与全部 PTY 终端.
                let state = app_handle.state::<DesktopProcesses>();
                app_handle.state::<TerminalSessions>().close_all();
                tauri::async_runtime::block_on(async {
                    state.shutdown().await;
                });
                tracing::info!("tauri exit event — child processes stopped");
            }
        });
}
