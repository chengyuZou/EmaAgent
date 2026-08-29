// 创建附着于聊天窗口的原生网页视图，并处理导航、尺寸和显隐。
use serde::{Deserialize, Serialize};
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder},
    Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, Window,
};
use tauri_plugin_opener::OpenerExt;

const BROWSER_EVENT: &str = "browser:event";

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum BrowserEvent {
    Loading { browser_id: String, loading: bool },
    LocationChanged { browser_id: String, url: String },
    TitleChanged { browser_id: String, title: String },
}

pub fn open(
    window: Window,
    browser_id: String,
    url: String,
    bounds: BrowserBounds,
) -> Result<(), String> {
    let parsed = parse_url(&url)?;
    let label = browser_label(&browser_id);
    if let Some(webview) = window.app_handle().get_webview(&label) {
        set_bounds(&window, &browser_id, bounds)?;
        webview.show().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let load_window = window.clone();
    let load_id = browser_id.clone();
    let title_window = window.clone();
    let title_id = browser_id.clone();
    let opener = window.app_handle().clone();
    let builder = WebviewBuilder::new(label, WebviewUrl::External(parsed))
        .on_navigation(|url| matches!(url.scheme(), "http" | "https"))
        .on_new_window(move |url, _| {
            let _ = opener.opener().open_url(url.as_str(), None::<&str>);
            NewWindowResponse::Deny
        })
        .on_page_load(move |_webview, payload| {
            let loading = payload.event() == PageLoadEvent::Started;
            let _ = load_window.emit(
                BROWSER_EVENT,
                BrowserEvent::Loading {
                    browser_id: load_id.clone(),
                    loading,
                },
            );
            let _ = load_window.emit(
                BROWSER_EVENT,
                BrowserEvent::LocationChanged {
                    browser_id: load_id.clone(),
                    url: payload.url().to_string(),
                },
            );
        })
        .on_document_title_changed(move |_webview, title| {
            let _ = title_window.emit(
                BROWSER_EVENT,
                BrowserEvent::TitleChanged {
                    browser_id: title_id.clone(),
                    title,
                },
            );
        });

    window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)),
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn navigate(window: &Window, browser_id: &str, url: &str) -> Result<(), String> {
    webview(window, browser_id)?
        .navigate(parse_url(url)?)
        .map_err(|error| error.to_string())
}

pub fn back(window: &Window, browser_id: &str) -> Result<(), String> {
    webview(window, browser_id)?
        .eval("history.back()")
        .map_err(|error| error.to_string())
}

pub fn forward(window: &Window, browser_id: &str) -> Result<(), String> {
    webview(window, browser_id)?
        .eval("history.forward()")
        .map_err(|error| error.to_string())
}

pub fn reload(window: &Window, browser_id: &str) -> Result<(), String> {
    webview(window, browser_id)?
        .reload()
        .map_err(|error| error.to_string())
}

pub fn set_bounds(window: &Window, browser_id: &str, bounds: BrowserBounds) -> Result<(), String> {
    let webview = webview(window, browser_id)?;
    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .and_then(|_| {
            webview.set_size(LogicalSize::new(
                bounds.width.max(1.0),
                bounds.height.max(1.0),
            ))
        })
        .map_err(|error| error.to_string())
}

pub fn set_visible(window: &Window, browser_id: &str, visible: bool) -> Result<(), String> {
    let webview = webview(window, browser_id)?;
    if visible {
        webview.show()
    } else {
        webview.hide()
    }
    .map_err(|error| error.to_string())
}

pub fn close(window: &Window, browser_id: &str) -> Result<(), String> {
    if let Some(webview) = window.app_handle().get_webview(&browser_label(browser_id)) {
        webview.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn webview(window: &Window, browser_id: &str) -> Result<tauri::Webview, String> {
    window
        .app_handle()
        .get_webview(&browser_label(browser_id))
        .ok_or_else(|| "浏览器页面不存在".to_string())
}

fn browser_label(browser_id: &str) -> String {
    format!("browser:{browser_id}")
}

fn parse_url(value: &str) -> Result<tauri::Url, String> {
    let url = value
        .parse::<tauri::Url>()
        .map_err(|_| "请输入有效的网址".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("浏览器只支持 http 和 https 地址".into());
    }
    Ok(url)
}
