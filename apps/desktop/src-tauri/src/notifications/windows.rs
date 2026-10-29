#[cfg(test)]
use super::permission_notification::notification_xml;
use super::permission_notification::PresentedNotification;
use super::{
    DesktopNotificationAction, InteractionKind, InteractionNotificationAction,
    InteractionNotificationUpdate, NotificationAction, SessionCompletionNotification,
    SessionNotificationAction,
};
use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::{mpsc, Mutex};
use std::thread::{self, JoinHandle};
use tauri::ipc::Channel;
use tauri::Manager;
use tokio::sync::oneshot;
use windows::core::{implement, IUnknown, Interface, Ref, BOOL, GUID, HSTRING, PCWSTR};
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
use windows::UI::Notifications::{ToastNotificationManager, ToastNotifier};

pub(super) const NOTIFICATION_GROUP: &str = "interactions";
#[cfg(all(debug_assertions, not(test)))]
const ACTIVATOR_ID: GUID = GUID::from_u128(0xb02ed455_1278_457d_ba44_0276097f6237);
#[cfg(all(not(debug_assertions), not(test)))]
const ACTIVATOR_ID: GUID = GUID::from_u128(0x06949391_2174_45d2_8d15_e3e8899ae866);
#[cfg(test)]
const ACTIVATOR_ID: GUID = GUID::from_u128(0x3190eeda_a908_4b10_a211_d9c3fead4d5f);

enum Command {
    Connect {
        channel: Channel<DesktopNotificationAction>,
        main_window_handle: usize,
        reply: oneshot::Sender<Result<bool, String>>,
    },
    Update(
        InteractionNotificationUpdate,
        oneshot::Sender<Result<(), String>>,
    ),
    Completion(
        SessionCompletionNotification,
        oneshot::Sender<Result<(), String>>,
    ),
    Activated {
        app_id: String,
        arguments: String,
    },
    Refresh,
    Shutdown,
}

pub struct DesktopNotifications {
    sender: mpsc::Sender<Command>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl DesktopNotifications {
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
        channel: Channel<DesktopNotificationAction>,
    ) -> Result<bool, String> {
        // 进入通知线程前取窗口句柄. 退出时 UI 线程会等待该线程结束,
        // 通知线程不能反过来等待 UI 线程读取窗口, 否则会互相等待.
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

    pub async fn show_completion(
        &self,
        notice: SessionCompletionNotification,
    ) -> Result<(), String> {
        let (reply, received) = oneshot::channel();
        self.sender
            .send(Command::Completion(notice, reply))
            .map_err(|error| error.to_string())?;
        received.await.map_err(|error| error.to_string())?
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

// COM 回调和 Tauri command 只投递消息. 同一个 MTA 线程处理注册、发送与删除,
// 避免通知刚被移除又被并发的 Show 重新显示.
fn run(app: tauri::AppHandle, sender: mpsc::Sender<Command>, receiver: mpsc::Receiver<Command>) {
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
                Command::Update(_, reply) | Command::Completion(_, reply) => {
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

pub(super) struct WindowsNotifications {
    pub(super) main_window_handle: Option<usize>,
    pub(super) registration: Registration,
    pub(super) notifier: ToastNotifier,
    pub(super) channel: Option<Channel<DesktopNotificationAction>>,
    pub(super) undelivered: Vec<DesktopNotificationAction>,
    pub(super) viewed_session_id: Option<String>,
    // 供应商的 ToolCallId 可能跨 Session 或 Turn 重复, 因此使用三个身份共同定位.
    pub(super) notices: HashMap<(String, String, String), PresentedNotification>,
    // 每个 Session 只保留最新完成通知的点击目标, 新结果替换旧通知.
    pub(super) completions: HashMap<String, (String, String)>,
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
        let notifier = ToastNotificationManager::CreateToastNotifierWithId(&registration.app_id)
            .map_err(|error| error.to_string())?;
        // Permission 等待只存在于内存. 重启后无法回答旧请求, 先清掉旧通知入口.
        ToastNotificationManager::History()
            .and_then(|history| {
                history.RemoveGroupWithId(&HSTRING::from(NOTIFICATION_GROUP), &registration.app_id)
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
            completions: HashMap::new(),
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
                    let DesktopNotificationAction::Interaction(action) = action else {
                        return true;
                    };
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
            Command::Completion(notice, reply) => {
                let _ = reply.send(self.show_completion(notice));
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
                if action == NotificationAction::OpenSession {
                    if let Some((session_id, _)) = self
                        .completions
                        .iter()
                        .find(|(_, (_, saved_tag))| saved_tag == tag)
                    {
                        self.deliver(DesktopNotificationAction::Session(
                            SessionNotificationAction::OpenSession {
                                session_id: session_id.clone(),
                            },
                        ));
                        return;
                    }
                }
                let Some(notice) = self.notices.values().find(|notice| notice.tag == tag) else {
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
                self.deliver(DesktopNotificationAction::Interaction(event));
            }
            Command::Shutdown => {}
        }
    }

    fn deliver(&mut self, action: DesktopNotificationAction) {
        if let Some(channel) = &self.channel {
            if channel.send(action.clone()).is_ok() {
                return;
            }
        }
        self.undelivered.push(action);
    }
}

impl Drop for WindowsNotifications {
    fn drop(&mut self) {
        for mut notice in std::mem::take(&mut self.notices).into_values() {
            self.hide(&mut notice);
        }
        // 完成通知的点击目标也只存在于本进程. 退出时清掉本组, 避免留下失效入口.
        let _ = ToastNotificationManager::History().and_then(|history| {
            history.RemoveGroupWithId(
                &HSTRING::from(NOTIFICATION_GROUP),
                &self.registration.app_id,
            )
        });
    }
}

pub(super) struct Registration {
    pub(super) app_id: HSTRING,
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
        std::fs::write(
            &icon_path,
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../assets/icons/icon.png"
            )),
        )
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
        // 两个注册键只属于本进程的通知通道, 不改安装器创建的应用身份.
        // 键是易失的, 异常退出后也会随 Windows 用户会话结束清除.
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
        // Windows 保证此回调中的两个字符串以空字符结束.
        let app_id = unsafe { app_id.to_string()? };
        let arguments = unsafe { arguments.to_string()? };
        let _ = self.sender.send(Command::Activated { app_id, arguments });
        Ok(())
    }
}

pub(super) fn parse_action(arguments: &str) -> Option<(NotificationAction, &str)> {
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

pub(super) fn xml_text(value: &str, limit: usize) -> String {
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

#[cfg(test)]
mod tests {
    include!("../../tests/interactionNotifications.rs");
}
