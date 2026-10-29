pub mod commands;
#[path = "permissionNotification.rs"]
mod permission_notification;
#[path = "sessionNotification.rs"]
mod session_notification;
#[cfg(windows)]
mod windows;
pub use permission_notification::*;
pub use session_notification::*;

use serde::Serialize;
#[cfg(not(windows))]
use tauri::ipc::Channel;

// 同一个原生点击通道承载批准操作和普通打开聊天, 后者没有 ToolCall 身份.
#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
pub enum DesktopNotificationAction {
    Interaction(InteractionNotificationAction),
    Session(SessionNotificationAction),
}

#[cfg(windows)]
pub use windows::DesktopNotifications;

#[cfg(not(windows))]
pub struct DesktopNotifications;

#[cfg(not(windows))]
impl DesktopNotifications {
    pub fn start(_app: tauri::AppHandle) -> Self {
        Self
    }

    pub async fn connect(
        &self,
        _window: &tauri::WebviewWindow,
        _channel: Channel<DesktopNotificationAction>,
    ) -> Result<bool, String> {
        Ok(false)
    }

    pub async fn update(&self, _update: InteractionNotificationUpdate) -> Result<(), String> {
        Ok(())
    }

    pub fn refresh(&self) {}
    pub fn shutdown(&self) {}

    pub async fn show_completion(
        &self,
        _notice: SessionCompletionNotification,
    ) -> Result<(), String> {
        Ok(())
    }
}
