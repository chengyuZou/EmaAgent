// 组装 Tauri 插件、桌面能力、共享状态和应用生命周期。
mod bundled_data;
mod commands;
mod desktop;
mod logging;
mod processes;

use tauri::{Manager, RunEvent};

use commands::{
    browser_back, browser_forward, close_browser, close_session_terminals, close_terminal,
    get_narrative_port, get_server_port, get_server_secret, list_system_fonts, navigate_browser,
    open_browser, open_path, open_terminal, open_window, quit_app, read_draft_image, reload_browser,
    report_live2d_diagnostic, resize_terminal, set_always_on_top, set_browser_bounds,
    set_browser_visible, set_passthrough, start_narrative, wait_narrative_exit, write_terminal,
};
use desktop::terminal::TerminalSessions;
use desktop::windows::{handle_window_event, show_main_window};
use processes::DesktopProcesses;

pub fn run() {
    logging::init_logging();

    let processes = DesktopProcesses::new().expect("failed to initialize desktop child processes");
    let processes_for_setup = processes.clone();

    tauri::Builder::default()
        // 单实例插件在 setup 前取得所有权，第二实例只能唤醒主窗口。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(processes)
        .manage(TerminalSessions::new())
        .invoke_handler(tauri::generate_handler![
            get_server_secret,
            get_server_port,
            report_live2d_diagnostic,
            get_narrative_port,
            start_narrative,
            wait_narrative_exit,
            list_system_fonts,
            set_always_on_top,
            set_passthrough,
            quit_app,
            open_window,
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
            let app_handle = app.handle().clone();
            let processes = processes_for_setup.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = processes.start(app_handle).await {
                    tracing::error!(%error, "desktop child process startup failed");
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
                // 最后防线负责回收异常退出路径遗留的整棵子进程树与全部 PTY 终端。
                let state = app_handle.state::<DesktopProcesses>();
                app_handle.state::<TerminalSessions>().close_all();
                tauri::async_runtime::block_on(async {
                    state.shutdown().await;
                });
                tracing::info!("tauri exit event — child processes stopped");
            }
        });
}
