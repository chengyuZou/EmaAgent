use tokio::process::Command;

pub(super) fn configure_web_proxy(command: &mut Command) {
    // Only web tools consume this value. Do not change HTTP_PROXY or model-provider networking.
    #[cfg(windows)]
    command.env(
        "EMA_WEB_SYSTEM_PROXY",
        serde_json::to_string(&read_windows_proxy()).expect("proxy settings serialize"),
    );
    #[cfg(not(windows))]
    command.env_remove("EMA_WEB_SYSTEM_PROXY");
}

#[cfg(windows)]
#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemWebProxy {
    proxy: String,
    bypass: String,
    automatic: bool,
    read_failed: bool,
}

#[cfg(windows)]
fn read_windows_proxy() -> SystemWebProxy {
    use windows::Win32::Foundation::{GlobalFree, ERROR_FILE_NOT_FOUND, HGLOBAL};
    use windows::Win32::Networking::WinHttp::{
        WinHttpGetIEProxyConfigForCurrentUser, WINHTTP_CURRENT_USER_IE_PROXY_CONFIG,
    };
    use windows_core::HRESULT;

    let mut config = WINHTTP_CURRENT_USER_IE_PROXY_CONFIG::default();
    unsafe {
        let result = WinHttpGetIEProxyConfigForCurrentUser(&mut config);
        let settings = match result {
            Ok(()) => SystemWebProxy {
                proxy: copy_proxy_string(config.lpszProxy),
                bypass: copy_proxy_string(config.lpszProxyBypass),
                automatic: config.fAutoDetect.as_bool()
                    || !copy_proxy_string(config.lpszAutoConfigUrl).is_empty(),
                read_failed: false,
            },
            Err(error) => SystemWebProxy {
                read_failed: error.code() != HRESULT::from_win32(ERROR_FILE_NOT_FOUND.0),
                ..Default::default()
            },
        };
        // WinHTTP allocates these strings with GlobalAlloc; copy before releasing each pointer.
        for pointer in [
            config.lpszProxy,
            config.lpszProxyBypass,
            config.lpszAutoConfigUrl,
        ] {
            if !pointer.is_null() {
                let _ = GlobalFree(Some(HGLOBAL(pointer.0.cast())));
            }
        }
        settings
    }
}

#[cfg(windows)]
unsafe fn copy_proxy_string(value: windows_core::PWSTR) -> String {
    if value.is_null() {
        String::new()
    } else {
        String::from_utf16_lossy(value.as_wide())
    }
}

#[cfg(all(test, windows))]
#[path = "../../tests/processes/webProxy.rs"]
mod tests;
