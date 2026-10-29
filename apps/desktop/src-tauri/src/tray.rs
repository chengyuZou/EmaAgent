use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

use crate::windows::stage_interaction::set_stage_passthrough;
use crate::windows::{show_stage_window, toggle_stage_window};

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
            "disable_passthrough",
            "关闭点击穿透",
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
                toggle_stage_window(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_stage_window(app),
            "disable_passthrough" => {
                if let Some(window) = app.get_webview_window("stage") {
                    if let Err(error) = set_stage_passthrough(&window, false) {
                        tracing::error!(%error, "failed to disable stage window click passthrough");
                        return;
                    }
                    if let Err(error) = window.unminimize() {
                        tracing::warn!(%error, "failed to restore stage window from minimized state");
                    }
                    show_stage_window(app);
                }
            }
            "quit" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    crate::app_lifecycle::quit_app(app).await;
                });
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}
