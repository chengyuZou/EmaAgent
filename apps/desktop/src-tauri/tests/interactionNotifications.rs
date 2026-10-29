use super::*;
use crate::notifications::InteractionNotification;
use windows::{Data::Xml::Dom::XmlDocument, UI::Notifications::ToastNotification};

fn request(kind: InteractionKind) -> InteractionNotification {
    InteractionNotification {
        session_id: "session-a".into(),
        turn_id: "turn-a".into(),
        tool_call_id: "call-a".into(),
        kind,
        session_approval_description: Some("Allow this command in this Session.".into()),
        title: "A & <B>".into(),
        body: "A \"quoted\" tool\u{0}".into(),
    }
}

#[test]
fn permission_buttons_keep_distinct_actions_and_escape_external_text() {
    let xml = notification_xml(&request(InteractionKind::Permission), "0123456789abcdef");
    assert!(xml.contains("A &amp; &lt;B&gt;"));
    assert!(xml.contains("A &quot;quoted&quot; tool"));
    assert!(!xml.contains('\0'));
    for action in ["open", "allow", "allowSession", "deny"] {
        assert!(xml.contains(&format!("{action}:0123456789abcdef")));
    }
    assert_eq!(xml.matches("<action ").count(), 3);
}

#[test]
fn ask_only_offers_system_dismiss_and_body_navigation() {
    let xml = notification_xml(&request(InteractionKind::AskUser), "0123456789abcdef");
    assert_eq!(xml.matches("<action ").count(), 1);
    assert!(xml.contains("arguments=\"dismiss\" activationType=\"system\""));
    assert!(!xml.contains("arguments=\"allow"));
    assert!(xml.contains("launch=\"open:0123456789abcdef\""));
}

#[test]
fn activation_arguments_do_not_accept_unknown_actions_or_arbitrary_targets() {
    assert_eq!(
        parse_action("allowSession:0123456789abcdef"),
        Some((NotificationAction::AllowSession, "0123456789abcdef"))
    );
    assert_eq!(parse_action("dismiss:0123456789abcdef"), None);
    assert_eq!(parse_action("allow:session-a"), None);
    assert_eq!(parse_action("allow:0123456789abcdef:other"), None);
}

#[test]
fn windows_parses_the_payload_and_dispatches_the_com_callback() {
    use windows::Win32::System::Com::CoGetClassObject;
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
        .ok()
        .unwrap();
    struct ComScope;
    impl Drop for ComScope {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }
    let _com = ComScope;
    let xml = XmlDocument::new().unwrap();
    xml.LoadXml(&HSTRING::from(notification_xml(
        &request(InteractionKind::Permission),
        "0123456789abcdef",
    )))
    .unwrap();
    let toast = ToastNotification::CreateToastNotification(&xml).unwrap();
    assert_eq!(
        toast
            .Content()
            .unwrap()
            .DocumentElement()
            .unwrap()
            .TagName()
            .unwrap(),
        "toast"
    );

    let (sender, receiver) = mpsc::channel();
    let factory: IClassFactory = NotificationFactory { sender }.into();
    let test_class = GUID::from_u128(rand::random());
    let cookie = unsafe {
        CoRegisterClassObject(
            &test_class,
            &factory,
            CLSCTX_LOCAL_SERVER,
            REGCLS_MULTIPLEUSE,
        )
    }
    .unwrap();
    struct ClassRegistration(u32);
    impl Drop for ClassRegistration {
        fn drop(&mut self) {
            let _ = unsafe { CoRevokeClassObject(self.0) };
        }
    }
    let _class = ClassRegistration(cookie);
    let registered: IClassFactory =
        unsafe { CoGetClassObject(&test_class, CLSCTX_LOCAL_SERVER, None) }.unwrap();
    let callback: INotificationActivationCallback =
        unsafe { registered.CreateInstance(None) }.unwrap();
    unsafe {
        callback.Activate(
            &HSTRING::from("ema-notification-test"),
            &HSTRING::from("allow:0123456789abcdef"),
            &[],
        )
    }
    .unwrap();
    match receiver
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap()
    {
        Command::Activated { app_id, arguments } => {
            assert_eq!(app_id, "ema-notification-test");
            assert_eq!(arguments, "allow:0123456789abcdef");
        }
        _ => panic!("unexpected native callback"),
    }
}

#[test]
#[ignore = "Shows a harmless Windows notification with an isolated test identity"]
fn windows_accepts_a_real_notification() {
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::ToastFailedEventArgs;

    let identifier = format!(
        "com.emaagent.notificationProbe.{:016x}",
        rand::random::<u64>()
    );
    let cache_dir = std::env::temp_dir().join(&identifier);
    let icon_dir = cache_dir.join("notifications");
    let result = thread::spawn(move || -> Result<(), String> {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .map_err(|error| error.to_string())?;
        let (sender, _receiver) = mpsc::channel();
        let result = (|| {
            let registration =
                Registration::create(identifier, &icon_dir, "Ema notification probe", sender)?;
            let notifier =
                ToastNotificationManager::CreateToastNotifierWithId(&registration.app_id)
                    .map_err(|error| error.to_string())?;
            let mut notifications = WindowsNotifications {
                main_window_handle: None,
                registration,
                notifier,
                channel: None,
                undelivered: Vec::new(),
                viewed_session_id: None,
                notices: HashMap::new(),
                completions: HashMap::new(),
            };
            eprintln!("probe identity: {}", notifications.registration.app_id);
            let request = InteractionNotification {
                title: "Ema notification probe".into(),
                body: "Display test only. No button approves or runs a tool.".into(),
                ..request(InteractionKind::Permission)
            };
            let key = (
                request.session_id.clone(),
                request.turn_id.clone(),
                request.tool_call_id.clone(),
            );
            let mut notice = PresentedNotification {
                request,
                tag: "0123456789abcdef".into(),
                show_attempted: true,
                toast: None,
            };
            notifications.show(&mut notice)?;
            let toast = notice.toast.as_ref().unwrap().clone();
            notifications.notices.insert(key, notice);
            let (failed, failure) = mpsc::channel();
            let token = toast
                .Failed(
                    &TypedEventHandler::<ToastNotification, ToastFailedEventArgs>::new(
                        move |_, args| {
                            let _ = failed.send(args.ok()?.ErrorCode()?);
                            Ok(())
                        },
                    ),
                )
                .map_err(|error| error.to_string())?;
            let failure = failure.recv_timeout(std::time::Duration::from_secs(3)).ok();
            let history = ToastNotificationManager::History()
                .and_then(|history| history.GetHistoryWithId(&notifications.registration.app_id))
                .map_err(|error| error.to_string())?;
            let count = history.Size().map_err(|error| error.to_string())?;
            toast
                .RemoveFailed(token)
                .map_err(|error| error.to_string())?;
            eprintln!("asynchronous failure: {failure:?}; history count: {count}");
            if let Some(error) = failure {
                return Err(format!("Windows rejected notification: {error:?}"));
            }
            if count == 0 {
                return Err("Windows did not retain the notification in history".into());
            }
            Ok(())
        })();
        unsafe {
            CoUninitialize();
        }
        result
    })
    .join()
    .unwrap();
    let _ = std::fs::remove_file(cache_dir.join("notifications/icon.png"));
    let _ = std::fs::remove_dir(cache_dir.join("notifications"));
    let _ = std::fs::remove_dir(cache_dir);
    assert!(result.is_ok(), "{result:?}");
}

#[test]
fn one_time_permission_has_no_session_button() {
    let mut notice = request(InteractionKind::Permission);
    notice.session_approval_description = None;
    let xml = notification_xml(&notice, "0123456789abcdef");
    assert_eq!(xml.matches("<action ").count(), 2);
    assert!(!xml.contains("allowSession:"));
}
