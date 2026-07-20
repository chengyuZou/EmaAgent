// 创建系统托盘并处理显示主窗口与可靠退出操作。
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

use crate::desktop::window_lifecycle::{show_main_window, toggle_main_window};
use crate::runtime::DesktopRuntimeSupervisor;

pub fn install(app: &mut tauri::App) -> tauri::Result<()> {
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
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => {
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
}
