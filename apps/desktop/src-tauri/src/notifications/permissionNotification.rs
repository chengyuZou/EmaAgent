use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum InteractionKind {
    Permission,
    AskUser,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionNotification {
    pub session_id: String,
    pub turn_id: String,
    pub tool_call_id: String,
    pub kind: InteractionKind,
    pub session_approval_description: Option<String>,
    pub title: String,
    pub body: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionNotificationUpdate {
    // null 表示 main 未显示聊天, 包括正在查看设置页.
    pub viewed_session_id: Option<String>,
    // 每个 Session 只提交现有交互队列的队首, 不为后面的请求提前弹通知.
    pub notifications: Vec<InteractionNotification>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum NotificationAction {
    OpenSession,
    Allow,
    AllowSession,
    Deny,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionNotificationAction {
    pub session_id: String,
    pub turn_id: String,
    pub tool_call_id: String,
    pub action: NotificationAction,
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
pub(super) struct PresentedNotification {
    pub(super) request: InteractionNotification,
    pub(super) tag: String,
    // 用户关闭通知后不重复弹出. Show 失败也记为已尝试,
    // 避免 Store 更新时反复向已禁用的通知通道重试.
    pub(super) show_attempted: bool,
    pub(super) toast: Option<ToastNotification>,
}

#[cfg(windows)]
impl WindowsNotifications {
    pub(super) fn refresh(&mut self) -> Result<(), String> {
        let foreground = self
            .main_window_handle
            .is_some_and(|handle| unsafe { GetForegroundWindow().0 as usize == handle });
        let mut first_error = None;
        // 临时取出记录逐个处理, 调用 COM 时不持有 Rust 互斥锁.
        let mut notices = std::mem::take(&mut self.notices);
        for notice in notices.values_mut() {
            let viewing =
                foreground && self.viewed_session_id.as_deref() == Some(&notice.request.session_id);
            if viewing {
                self.hide(notice);
                continue;
            }
            if notice.show_attempted {
                continue;
            }
            notice.show_attempted = true;
            if let Err(error) = self.show(notice) {
                first_error.get_or_insert(error);
            }
        }
        self.notices = notices;
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    pub(super) fn show(&self, notice: &mut PresentedNotification) -> Result<(), String> {
        let show = || -> windows::core::Result<ToastNotification> {
            // 某些桌面身份读取 Setting 会失败, 但 Show 可以接受.
            // 直接发送, 由 Windows 按用户的通知设置决定是否展示.
            let xml = XmlDocument::new()?;
            xml.LoadXml(&HSTRING::from(notification_xml(
                &notice.request,
                &notice.tag,
            )))?;
            let toast = ToastNotification::CreateToastNotification(&xml)?;
            toast.SetTag(&HSTRING::from(&notice.tag))?;
            toast.SetGroup(&HSTRING::from(NOTIFICATION_GROUP))?;
            self.notifier.Show(&toast)?;
            Ok(toast)
        };
        notice.toast = Some(show().map_err(|error| error.to_string())?);
        Ok(())
    }

    pub(super) fn hide(&self, notice: &mut PresentedNotification) {
        if let Some(toast) = notice.toast.take() {
            if let Err(error) = self.notifier.Hide(&toast) {
                tracing::warn!(%error, "failed to hide interaction notification");
            }
            if let Err(error) = ToastNotificationManager::History().and_then(|history| {
                history.RemoveGroupedTagWithId(
                    &HSTRING::from(&notice.tag),
                    &HSTRING::from(NOTIFICATION_GROUP),
                    &self.registration.app_id,
                )
            }) {
                tracing::warn!(%error, "failed to remove interaction notification history");
            }
        }
    }
}

#[cfg(windows)]
pub(super) fn notification_xml(request: &InteractionNotification, tag: &str) -> String {
    let actions = match request.kind {
        InteractionKind::Permission => {
            let session_button = if request.session_approval_description.is_some() {
                format!("<action content=\"本会话允许\" arguments=\"allowSession:{tag}\" activationType=\"background\"/>")
            } else {
                String::new()
            };
            format!(
                "<action content=\"允许\" arguments=\"allow:{tag}\" activationType=\"background\"/>{session_button}\
                 <action content=\"拒绝\" arguments=\"deny:{tag}\" activationType=\"background\"/>"
            )
        }
        InteractionKind::AskUser => {
            "<action content=\"关闭\" arguments=\"dismiss\" activationType=\"system\"/>".into()
        }
    };
    format!(
        "<toast launch=\"open:{tag}\" scenario=\"reminder\" activationType=\"foreground\">\
         <visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual>\
         <actions>{actions}</actions><audio silent=\"true\"/></toast>",
        // 原生通知只显示简短理由, 完整请求仍可在聊天卡片中查看.
        xml_text(&request.title, 120),
        xml_text(&request.body, 512),
    )
}
