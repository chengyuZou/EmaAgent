use super::{
    DesktopNotificationAction, DesktopNotifications, InteractionNotificationUpdate,
    SessionCompletionNotification,
};

#[tauri::command]
pub async fn connect_desktop_notifications(
    window: tauri::WebviewWindow,
    notifications: tauri::State<'_, DesktopNotifications>,
    on_action: tauri::ipc::Channel<DesktopNotificationAction>,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("Interaction notifications belong to the main window".into());
    }
    notifications.connect(&window, on_action).await
}

#[tauri::command]
pub async fn sync_interaction_notifications(
    window: tauri::WebviewWindow,
    notifications: tauri::State<'_, DesktopNotifications>,
    update: InteractionNotificationUpdate,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Interaction notifications belong to the main window".into());
    }
    notifications.update(update).await
}

#[tauri::command]
pub async fn show_session_completion(
    window: tauri::WebviewWindow,
    notifications: tauri::State<'_, DesktopNotifications>,
    notice: SessionCompletionNotification,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Completion notifications belong to the main window".into());
    }
    notifications.show_completion(notice).await
}
