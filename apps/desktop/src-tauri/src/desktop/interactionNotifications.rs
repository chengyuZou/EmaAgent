use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

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
    pub title: String,
    pub body: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionNotificationUpdate {
    // null means main is not displaying a Session, including while Settings is open.
    pub viewed_session_id: Option<String>,
    // Only the current head of each Session's existing interaction queue is included.
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
pub use platform::InteractionNotifications;

#[cfg(not(windows))]
pub struct InteractionNotifications;

#[cfg(not(windows))]
impl InteractionNotifications {
    pub fn start(_app: tauri::AppHandle) -> Self {
        Self
    }

    pub async fn connect(
        &self,
        _window: &tauri::WebviewWindow,
        _channel: Channel<InteractionNotificationAction>,
    ) -> Result<bool, String> {
        Ok(false)
    }

    pub async fn update(&self, _update: InteractionNotificationUpdate) -> Result<(), String> {
        Ok(())
    }

    pub fn refresh(&self) {}
    pub fn shutdown(&self) {}
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::sync::{mpsc, Mutex};
    use std::thread::{self, JoinHandle};
    use tauri::Manager;
    use tokio::sync::oneshot;
    use windows::core::{implement, IUnknown, Interface, Ref, BOOL, GUID, HSTRING, PCWSTR};
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Win32::Foundation::{CLASS_E_NOAGGREGATION, E_POINTER};
    use windows::Win32::System::Com::{
        CoInitializeEx, CoRegisterClassObject, CoRevokeClassObject, CoUninitialize, IClassFactory,
        IClassFactory_Impl, CLSCTX_LOCAL_SERVER, COINIT_MULTITHREADED, REGCLS_MULTIPLEUSE,
    };
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
        KEY_WRITE, REG_OPTION_VOLATILE, REG_SZ,
    };
    use windows::Win32::UI::Notifications::{
        INotificationActivationCallback, INotificationActivationCallback_Impl,
        NOTIFICATION_USER_INPUT_DATA,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager, ToastNotifier};

    const NOTIFICATION_GROUP: &str = "interactions";
    #[cfg(all(debug_assertions, not(test)))]
    const ACTIVATOR_ID: GUID = GUID::from_u128(0xb02ed455_1278_457d_ba44_0276097f6237);
    #[cfg(all(not(debug_assertions), not(test)))]
    const ACTIVATOR_ID: GUID = GUID::from_u128(0x06949391_2174_45d2_8d15_e3e8899ae866);
    #[cfg(test)]
    const ACTIVATOR_ID: GUID = GUID::from_u128(0x3190eeda_a908_4b10_a211_d9c3fead4d5f);

    enum Command {
        Connect {
            channel: Channel<InteractionNotificationAction>,
            main_window_handle: usize,
            reply: oneshot::Sender<Result<bool, String>>,
        },
        Update(
            InteractionNotificationUpdate,
            oneshot::Sender<Result<(), String>>,
        ),
        Activated {
            app_id: String,
            arguments: String,
        },
        Refresh,
        Shutdown,
    }

    pub struct InteractionNotifications {
        sender: mpsc::Sender<Command>,
        worker: Mutex<Option<JoinHandle<()>>>,
    }

    impl InteractionNotifications {
        pub fn start(app: tauri::AppHandle) -> Self {
            let (sender, receiver) = mpsc::channel();
            let callback_sender = sender.clone();
            let worker = thread::Builder::new()
                .name("interaction-notifications".into())
                .spawn(move || run(app, callback_sender, receiver));
            let worker = match worker {
                Ok(worker) => Some(worker),
                Err(error) => {
                    tracing::warn!(%error, "failed to start Windows notification thread");
                    None
                }
            };
            Self {
                sender,
                worker: Mutex::new(worker),
            }
        }

        pub async fn connect(
            &self,
            window: &tauri::WebviewWindow,
            channel: Channel<InteractionNotificationAction>,
        ) -> Result<bool, String> {
            // Resolve the handle before entering the worker. Exit waits for that
            // worker, so it must never block on a Tauri UI-thread window getter.
            let main_window_handle = window.hwnd().map_err(|error| error.to_string())?.0 as usize;
            let (reply, received) = oneshot::channel();
            self.sender
                .send(Command::Connect {
                    channel,
                    main_window_handle,
                    reply,
                })
                .map_err(|error| error.to_string())?;
            received.await.map_err(|error| error.to_string())?
        }

        pub async fn update(&self, update: InteractionNotificationUpdate) -> Result<(), String> {
            let (reply, received) = oneshot::channel();
            self.sender
                .send(Command::Update(update, reply))
                .map_err(|error| error.to_string())?;
            received.await.map_err(|error| error.to_string())?
        }

        pub fn refresh(&self) {
            let _ = self.sender.send(Command::Refresh);
        }

        pub fn shutdown(&self) {
            let _ = self.sender.send(Command::Shutdown);
            if let Ok(mut worker) = self.worker.lock() {
                if let Some(worker) = worker.take() {
                    let _ = worker.join();
                }
            }
        }
    }

    // COM callbacks and Tauri commands only post messages. One MTA thread owns the
    // notifier, its registration, and presentation records, so removal cannot race Show.
    fn run(
        app: tauri::AppHandle,
        sender: mpsc::Sender<Command>,
        receiver: mpsc::Receiver<Command>,
    ) {
        let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.ok();
        let mut notifications = initialized
            .as_ref()
            .map_err(|error| error.to_string())
            .and_then(|_| WindowsNotifications::new(app, sender));
        if let Err(error) = &notifications {
            tracing::warn!(%error, "Windows interaction notifications unavailable");
        }
        while let Ok(command) = receiver.recv() {
            if matches!(command, Command::Shutdown) {
                break;
            }
            match &mut notifications {
                Ok(notifications) => notifications.receive(command),
                Err(error) => match command {
                    Command::Connect { reply, .. } => {
                        let _ = reply.send(Err(error.clone()));
                    }
                    Command::Update(_, reply) => {
                        let _ = reply.send(Err(error.clone()));
                    }
                    _ => {}
                },
            }
        }
        drop(notifications);
        if initialized.is_ok() {
            unsafe {
                CoUninitialize();
            }
        }
    }

    struct PresentedNotification {
        request: InteractionNotification,
        tag: String,
        // Dismissal must not cause repeated banners. A failed Show also counts
        // as an attempt so Store updates do not repeatedly retry a disabled channel.
        show_attempted: bool,
        toast: Option<ToastNotification>,
    }

    struct WindowsNotifications {
        main_window_handle: Option<usize>,
        registration: Registration,
        notifier: ToastNotifier,
        channel: Option<Channel<InteractionNotificationAction>>,
        undelivered: Vec<InteractionNotificationAction>,
        viewed_session_id: Option<String>,
        // Provider call IDs need not be unique across Sessions or later Turns.
        notices: HashMap<(String, String, String), PresentedNotification>,
    }

    impl WindowsNotifications {
        fn new(app: tauri::AppHandle, sender: mpsc::Sender<Command>) -> Result<Self, String> {
            let suffix = if cfg!(debug_assertions) {
                "interactions.dev"
            } else {
                "interactions"
            };
            let app_id = format!("{}.{}", app.config().identifier, suffix);
            let icon_dir = app
                .path()
                .app_cache_dir()
                .map_err(|error| error.to_string())?
                .join("notifications");
            let display_name = if cfg!(debug_assertions) {
                "Ema Dev"
            } else {
                "Ema"
            };
            let registration = Registration::create(app_id, &icon_dir, display_name, sender)?;
            let notifier =
                ToastNotificationManager::CreateToastNotifierWithId(&registration.app_id)
                    .map_err(|error| error.to_string())?;
            // Permission waits are memory-only. A previous crashed process cannot
            // resume them, so its notification group must not survive this startup.
            ToastNotificationManager::History()
                .and_then(|history| {
                    history
                        .RemoveGroupWithId(&HSTRING::from(NOTIFICATION_GROUP), &registration.app_id)
                })
                .map_err(|error| error.to_string())?;
            Ok(Self {
                main_window_handle: None,
                registration,
                notifier,
                channel: None,
                undelivered: Vec::new(),
                viewed_session_id: None,
                notices: HashMap::new(),
            })
        }

        fn receive(&mut self, command: Command) {
            match command {
                Command::Connect {
                    channel,
                    main_window_handle,
                    reply,
                } => {
                    self.channel = Some(channel);
                    self.main_window_handle = Some(main_window_handle);
                    let _ = reply.send(Ok(true));
                    for action in std::mem::take(&mut self.undelivered) {
                        self.deliver(action);
                    }
                }
                Command::Update(update, reply) => {
                    self.viewed_session_id = update.viewed_session_id;
                    let desired: HashMap<_, _> = update
                        .notifications
                        .into_iter()
                        .map(|request| {
                            let key = (
                                request.session_id.clone(),
                                request.turn_id.clone(),
                                request.tool_call_id.clone(),
                            );
                            (key, request)
                        })
                        .collect();
                    let removed: Vec<_> = self
                        .notices
                        .keys()
                        .filter(|id| !desired.contains_key(*id))
                        .cloned()
                        .collect();
                    for id in removed {
                        if let Some(mut notice) = self.notices.remove(&id) {
                            self.hide(&mut notice);
                        }
                    }
                    self.undelivered.retain(|action| {
                        desired.contains_key(&(
                            action.session_id.clone(),
                            action.turn_id.clone(),
                            action.tool_call_id.clone(),
                        ))
                    });
                    for (id, request) in desired {
                        self.notices
                            .entry(id)
                            .and_modify(|notice| {
                                notice.request = request.clone();
                            })
                            .or_insert_with(|| PresentedNotification {
                                request,
                                tag: format!("{:016x}", rand::random::<u64>()),
                                show_attempted: false,
                                toast: None,
                            });
                    }
                    let result = self.refresh();
                    let _ = reply.send(result);
                }
                Command::Refresh => {
                    if let Err(error) = self.refresh() {
                        tracing::warn!(%error, "failed to refresh Windows interaction notifications");
                    }
                }
                Command::Activated { app_id, arguments } => {
                    if app_id != self.registration.app_id.to_string() {
                        return;
                    }
                    let Some((action, tag)) = parse_action(&arguments) else {
                        return;
                    };
                    let Some(notice) = self.notices.values().find(|notice| notice.tag == tag)
                    else {
                        return;
                    };
                    if action != NotificationAction::OpenSession
                        && notice.request.kind != InteractionKind::Permission
                    {
                        return;
                    }
                    let event = InteractionNotificationAction {
                        session_id: notice.request.session_id.clone(),
                        turn_id: notice.request.turn_id.clone(),
                        tool_call_id: notice.request.tool_call_id.clone(),
                        action,
                    };
                    self.deliver(event);
                }
                Command::Shutdown => {}
            }
        }

        fn deliver(&mut self, action: InteractionNotificationAction) {
            if let Some(channel) = &self.channel {
                if channel.send(action.clone()).is_ok() {
                    return;
                }
            }
            self.undelivered.push(action);
        }

        fn refresh(&mut self) -> Result<(), String> {
            let foreground = self
                .main_window_handle
                .is_some_and(|handle| unsafe { GetForegroundWindow().0 as usize == handle });
            let mut first_error = None;
            // Temporarily take the records to keep all native operations serialized
            // without holding a Rust mutex during COM calls.
            let mut notices = std::mem::take(&mut self.notices);
            for notice in notices.values_mut() {
                let viewing = foreground
                    && self.viewed_session_id.as_deref() == Some(&notice.request.session_id);
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

        fn show(&self, notice: &mut PresentedNotification) -> Result<(), String> {
            let show = || -> windows::core::Result<ToastNotification> {
                // Setting can fail with ERROR_NOT_FOUND for a registered desktop
                // identity that Show accepts. Let Windows apply its notification
                // preferences during delivery rather than blocking that first call.
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

        fn hide(&self, notice: &mut PresentedNotification) {
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

    impl Drop for WindowsNotifications {
        fn drop(&mut self) {
            for mut notice in std::mem::take(&mut self.notices).into_values() {
                self.hide(&mut notice);
            }
        }
    }

    struct Registration {
        app_id: HSTRING,
        app_key: String,
        class_key: String,
        cookie: Option<u32>,
    }

    impl Registration {
        fn create(
            app_id: String,
            icon_dir: &std::path::Path,
            display_name: &str,
            sender: mpsc::Sender<Command>,
        ) -> Result<Self, String> {
            let class_id = format!("{{{ACTIVATOR_ID:?}}}");
            let mut registration = Self {
                app_key: format!("Software\\Classes\\AppUserModelId\\{app_id}"),
                class_key: format!("Software\\Classes\\CLSID\\{class_id}"),
                app_id: HSTRING::from(&app_id),
                cookie: None,
            };
            std::fs::create_dir_all(icon_dir).map_err(|error| error.to_string())?;
            let icon_path = icon_dir.join("icon.png");
            std::fs::write(&icon_path, include_bytes!("../../icons/icon.png"))
                .map_err(|error| error.to_string())?;
            let executable = std::env::current_exe().map_err(|error| error.to_string())?;
            set_registration_values(
                &registration.app_key,
                &[
                    ("DisplayName", display_name),
                    ("IconUri", &icon_path.to_string_lossy()),
                    ("CustomActivator", &class_id),
                ],
            )?;
            set_registration_values(&registration.class_key, &[])?;
            set_registration_values(
                &format!("{}\\LocalServer32", registration.class_key),
                &[(
                    "",
                    &format!("\"{}\" --ema-notification-activation", executable.display()),
                )],
            )?;
            let factory: IClassFactory = NotificationFactory { sender }.into();
            registration.cookie = Some(
                unsafe {
                    CoRegisterClassObject(
                        &ACTIVATOR_ID,
                        &factory,
                        CLSCTX_LOCAL_SERVER,
                        REGCLS_MULTIPLEUSE,
                    )
                }
                .map_err(|error| error.to_string())?,
            );
            Ok(registration)
        }
    }

    impl Drop for Registration {
        fn drop(&mut self) {
            if let Some(cookie) = self.cookie {
                let _ = unsafe { CoRevokeClassObject(cookie) };
            }
            // These two keys belong only to this in-process notification channel,
            // not the installer's Ema shortcut identity. They are also volatile so
            // a crash cannot leave a registration pointing at a removed Dev build
            // after the Windows user session ends.
            for key in [&self.app_key, &self.class_key] {
                let result = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, &HSTRING::from(key)) };
                if let Err(error) = result.ok() {
                    tracing::debug!(%error, "notification registration already removed");
                }
            }
        }
    }

    fn set_registration_values(path: &str, values: &[(&str, &str)]) -> Result<(), String> {
        let mut key = HKEY::default();
        unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                &HSTRING::from(path),
                None,
                PCWSTR::null(),
                REG_OPTION_VOLATILE,
                KEY_WRITE,
                None,
                &mut key,
                None,
            )
            .ok()
            .map_err(|error| error.to_string())?;
        }
        let result = values.iter().try_for_each(|(name, value)| {
            let bytes: Vec<u8> = value
                .encode_utf16()
                .chain(Some(0))
                .flat_map(u16::to_le_bytes)
                .collect();
            unsafe { RegSetValueExW(key, &HSTRING::from(*name), None, REG_SZ, Some(&bytes)) }
                .ok()
                .map_err(|error| error.to_string())
        });
        let _ = unsafe { RegCloseKey(key) };
        result
    }

    #[implement(IClassFactory)]
    struct NotificationFactory {
        sender: mpsc::Sender<Command>,
    }

    impl IClassFactory_Impl for NotificationFactory_Impl {
        fn CreateInstance(
            &self,
            outer: Ref<'_, IUnknown>,
            iid: *const GUID,
            result: *mut *mut c_void,
        ) -> windows::core::Result<()> {
            if !outer.is_null() {
                return Err(CLASS_E_NOAGGREGATION.into());
            }
            if iid.is_null() || result.is_null() {
                return Err(E_POINTER.into());
            }
            let callback: INotificationActivationCallback = NotificationCallback {
                sender: self.sender.clone(),
            }
            .into();
            unsafe {
                *result = std::ptr::null_mut();
                callback.query(iid, result).ok()
            }
        }

        fn LockServer(&self, _lock: BOOL) -> windows::core::Result<()> {
            Ok(())
        }
    }

    #[implement(INotificationActivationCallback)]
    struct NotificationCallback {
        sender: mpsc::Sender<Command>,
    }

    impl INotificationActivationCallback_Impl for NotificationCallback_Impl {
        fn Activate(
            &self,
            app_id: &PCWSTR,
            arguments: &PCWSTR,
            _input: *const NOTIFICATION_USER_INPUT_DATA,
            _count: u32,
        ) -> windows::core::Result<()> {
            if app_id.is_null() || arguments.is_null() {
                return Err(E_POINTER.into());
            }
            // Windows supplies these null-terminated strings for this callback.
            let app_id = unsafe { app_id.to_string()? };
            let arguments = unsafe { arguments.to_string()? };
            let _ = self.sender.send(Command::Activated { app_id, arguments });
            Ok(())
        }
    }

    fn parse_action(arguments: &str) -> Option<(NotificationAction, &str)> {
        let (action, tag) = arguments.split_once(':')?;
        if tag.len() != 16 || !tag.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        let action = match action {
            "open" => NotificationAction::OpenSession,
            "allow" => NotificationAction::Allow,
            "allowSession" => NotificationAction::AllowSession,
            "deny" => NotificationAction::Deny,
            _ => return None,
        };
        Some((action, tag))
    }

    fn xml_text(value: &str, limit: usize) -> String {
        let mut output = String::new();
        let mut characters = value.chars().filter(|character| {
            matches!(*character, '\t' | '\n' | '\r')
                || (*character >= '\u{20}' && *character != '\u{fffe}' && *character != '\u{ffff}')
        });
        for character in characters.by_ref().take(limit) {
            match character {
                '&' => output.push_str("&amp;"),
                '<' => output.push_str("&lt;"),
                '>' => output.push_str("&gt;"),
                '"' => output.push_str("&quot;"),
                '\'' => output.push_str("&apos;"),
                _ => output.push(character),
            }
        }
        if characters.next().is_some() {
            output.push_str("...");
        }
        output
    }

    fn notification_xml(request: &InteractionNotification, tag: &str) -> String {
        let actions = match request.kind {
            InteractionKind::Permission => format!(
                "<action content=\"允许\" arguments=\"allow:{tag}\" activationType=\"background\"/>\
                 <action content=\"本会话允许\" arguments=\"allowSession:{tag}\" activationType=\"background\"/>\
                 <action content=\"拒绝\" arguments=\"deny:{tag}\" activationType=\"background\"/>"
            ),
            InteractionKind::AskUser =>
                "<action content=\"关闭\" arguments=\"dismiss\" activationType=\"system\"/>".into(),
        };
        format!(
            "<toast launch=\"open:{tag}\" scenario=\"reminder\" activationType=\"foreground\">\
             <visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual>\
             <actions>{actions}</actions><audio silent=\"true\"/></toast>",
            // Keep the native payload small even when a provider gives a long
            // reason. The complete request remains available in the chat card.
            xml_text(&request.title, 120),
            xml_text(&request.body, 512),
        )
    }

    #[cfg(test)]
    mod tests {
        include!("../../tests/interactionNotifications.rs");
    }
}
