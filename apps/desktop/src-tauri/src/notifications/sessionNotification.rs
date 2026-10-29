use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionCompletionKind {
    TurnCompleted,
    TurnFailed,
    CompactCompleted,
    CompactFailed,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCompletionNotification {
    // 对应 TurnId 或手动压缩请求的通知 ID, 用于同一次完成事件去重.
    pub id: String,
    pub session_id: String,
    pub title: String,
    pub kind: SessionCompletionKind,
    pub viewed_session_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum SessionNotificationAction {
    OpenSession {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
}

#[cfg(windows)]
use super::windows::{xml_text, WindowsNotifications, NOTIFICATION_GROUP};
#[cfg(windows)]
use windows::{
    core::HSTRING,
    Data::Xml::Dom::XmlDocument,
    Win32::UI::WindowsAndMessaging::GetForegroundWindow,
    UI::Notifications::{ToastNotification, ToastNotificationManager},
};

#[cfg(windows)]
impl WindowsNotifications {
    pub(super) fn show_completion(
        &mut self,
        notice: SessionCompletionNotification,
    ) -> Result<(), String> {
        let foreground = self
            .main_window_handle
            .is_some_and(|handle| unsafe { GetForegroundWindow().0 as usize == handle });
        if foreground && notice.viewed_session_id.as_deref() == Some(&notice.session_id) {
            return Ok(());
        }
        if self
            .completions
            .get(&notice.session_id)
            .is_some_and(|(id, _)| id == &notice.id)
        {
            return Ok(());
        }
        let tag = format!("{:016x}", rand::random::<u64>());
        let body = match notice.kind {
            SessionCompletionKind::TurnCompleted => "本轮回复已完成, 点击查看.",
            SessionCompletionKind::TurnFailed => "本轮执行失败, 点击查看原因.",
            SessionCompletionKind::CompactCompleted => "手动压缩已完成, 点击查看.",
            SessionCompletionKind::CompactFailed => "手动压缩失败, 点击查看原因.",
        };
        let xml = XmlDocument::new().map_err(|error| error.to_string())?;
        xml.LoadXml(&HSTRING::from(format!(
            "<toast launch=\"open:{tag}\" duration=\"short\"><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual><audio silent=\"true\"/></toast>",
            xml_text(&notice.title, 120), body,
        ))).map_err(|error| error.to_string())?;
        let toast =
            ToastNotification::CreateToastNotification(&xml).map_err(|error| error.to_string())?;
        toast
            .SetTag(&HSTRING::from(&tag))
            .map_err(|error| error.to_string())?;
        toast
            .SetGroup(&HSTRING::from(NOTIFICATION_GROUP))
            .map_err(|error| error.to_string())?;
        self.notifier
            .Show(&toast)
            .map_err(|error| error.to_string())?;
        if let Some((_, old_tag)) = self.completions.insert(notice.session_id, (notice.id, tag)) {
            let _ = ToastNotificationManager::History().and_then(|history| {
                history.RemoveGroupedTagWithId(
                    &HSTRING::from(old_tag),
                    &HSTRING::from(NOTIFICATION_GROUP),
                    &self.registration.app_id,
                )
            });
        }
        Ok(())
    }
}
