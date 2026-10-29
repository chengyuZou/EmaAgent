use crate::notifications::DesktopNotifications;
use crate::server::ServerProcess;
use crate::terminal::TerminalSessions;
use crate::windows::pet_pointer::PetPointerTracking;
use crate::windows::{destroy_windows_before_exit, show_stage_window};
use tauri::{Manager, RunEvent};

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(DesktopNotifications::start(app.handle().clone()));
    #[cfg(windows)]
    if let Some(stage) = app.get_webview_window("stage") {
        crate::windows::webview_media::allow_app_media(&stage)?;
    }
    let handle = app.handle().clone();
    let server = app.state::<ServerProcess>().inner().clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = server.start(handle).await {
            tracing::error!(%error, "Server startup failed");
        }
    });
    crate::tray::install(app)?;
    show_stage_window(app.handle());
    Ok(())
}

// 前端和托盘只发退出请求, 清理统一由下面的 Tauri 退出事件完成.
#[tauri::command]
pub async fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

pub fn handle_run_event(app: &tauri::AppHandle, event: RunEvent) {
    if let RunEvent::ExitRequested { api, .. } = &event {
        app.state::<DesktopNotifications>().shutdown();
        app.state::<PetPointerTracking>().stop();
        destroy_windows_before_exit(app, api);
    }
    if let RunEvent::Exit = event {
        app.state::<TerminalSessions>().close_all();
        // 窗口销毁后, 等 Server 进程树退出, 防止应用退出后仍留下后台程序.
        let server = app.state::<ServerProcess>();
        tauri::async_runtime::block_on(server.shutdown());
    }
}
