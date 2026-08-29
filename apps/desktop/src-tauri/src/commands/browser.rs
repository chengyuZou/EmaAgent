// 暴露原生浏览器页面的创建、导航、尺寸、显隐和关闭操作。
use tauri::Window;

use crate::desktop::browser::{self, BrowserBounds};

#[tauri::command]
pub async fn open_browser(
    window: Window,
    browser_id: String,
    url: String,
    bounds: BrowserBounds,
) -> Result<(), String> {
    browser::open(window, browser_id, url, bounds)
}

#[tauri::command]
pub fn navigate_browser(window: Window, browser_id: String, url: String) -> Result<(), String> {
    browser::navigate(&window, &browser_id, &url)
}

#[tauri::command]
pub fn browser_back(window: Window, browser_id: String) -> Result<(), String> {
    browser::back(&window, &browser_id)
}

#[tauri::command]
pub fn browser_forward(window: Window, browser_id: String) -> Result<(), String> {
    browser::forward(&window, &browser_id)
}

#[tauri::command]
pub fn reload_browser(window: Window, browser_id: String) -> Result<(), String> {
    browser::reload(&window, &browser_id)
}

#[tauri::command]
pub fn set_browser_bounds(
    window: Window,
    browser_id: String,
    bounds: BrowserBounds,
) -> Result<(), String> {
    browser::set_bounds(&window, &browser_id, bounds)
}

#[tauri::command]
pub fn set_browser_visible(
    window: Window,
    browser_id: String,
    visible: bool,
) -> Result<(), String> {
    browser::set_visible(&window, &browser_id, visible)
}

#[tauri::command]
pub fn close_browser(window: Window, browser_id: String) -> Result<(), String> {
    browser::close(&window, &browser_id)
}
