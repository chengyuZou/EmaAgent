use tauri::{Manager, WebviewWindow};
#[cfg(windows)]
use webview2_com::{
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Profile4, ICoreWebView2_13, COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY,
        COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    },
    SetPermissionStateCompletedHandler,
};
#[cfg(windows)]
use windows_core::{Interface, PCWSTR};

#[cfg(windows)]
const PACKAGED_APP_ORIGIN: &str = "http://tauri.localhost";
// 同一进程内的 WebView2 必须使用一致的浏览器参数, 否则后创建的窗口会被环境复用规则拒绝.
pub(crate) const SHARED_BROWSER_ARGS: &str = "--autoplay-policy=no-user-gesture-required";

#[cfg(windows)]
pub fn allow_app_media(window: &WebviewWindow) -> tauri::Result<()> {
    // 窗口刚创建时仍可能是 about:blank, 不能用当前页面 URL 决定授权地址.
    // 开发版读取 devUrl, 正式版的 stage/main 使用 Tauri 默认的 http 本地资源协议.
    let configured_origin = if tauri::is_dev() {
        window
            .app_handle()
            .config()
            .build
            .dev_url
            .as_ref()
            .map(|url| url.origin().ascii_serialization())
    } else {
        None
    };
    let origin = configured_origin.unwrap_or_else(|| PACKAGED_APP_ORIGIN.to_owned());

    // 只在自有窗口创建时调用, 不为外部浏览器子视图授权.
    window.with_webview(move |webview| {
        // with_webview 在原生 UI 线程执行, COM 接口不能移到异步任务里调用.
        let profile = unsafe {
            webview
                .controller()
                .CoreWebView2()
                .and_then(|webview| webview.cast::<ICoreWebView2_13>())
                .and_then(|webview| webview.Profile())
                .and_then(|profile| profile.cast::<ICoreWebView2Profile4>())
        };
        let profile = match profile {
            Ok(profile) => profile,
            Err(error) => {
                tracing::error!(%error, %origin, "failed to access WebView2 media permissions");
                return;
            }
        };
        let origin_utf16: Vec<u16> = origin.encode_utf16().chain(std::iter::once(0)).collect();

        // 直接把本应用在 profile 中已保存的拒绝状态改为允许.
        for (kind, permission) in [
            (COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, "microphone"),
            (COREWEBVIEW2_PERMISSION_KIND_CAMERA, "camera"),
            (COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY, "autoplay"),
        ] {
            let permission_origin = origin.clone();
            let completed = SetPermissionStateCompletedHandler::create(Box::new(move |result| {
                if let Err(error) = result {
                    tracing::error!(
                        %error,
                        origin = %permission_origin,
                        permission,
                        "failed to allow app media permission"
                    );
                }
                Ok(())
            }));
            if let Err(error) = unsafe {
                profile.SetPermissionState(
                    kind,
                    PCWSTR(origin_utf16.as_ptr()),
                    COREWEBVIEW2_PERMISSION_STATE_ALLOW,
                    &completed,
                )
            } {
                tracing::error!(%error, %origin, permission, "failed to set app media permission");
            }
        }
    })
}
