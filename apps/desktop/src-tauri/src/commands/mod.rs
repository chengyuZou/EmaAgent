// 汇总桌面宿主暴露给 WebView 的 Tauri commands。
mod browser;
mod desktop;
mod server;
mod terminal;

pub use browser::{
    browser_back, browser_forward, close_browser, navigate_browser, open_browser, reload_browser,
    set_browser_bounds, set_browser_visible,
};
pub use desktop::{open_window, quit_app, set_always_on_top, set_passthrough};
pub use server::{get_server_port, get_server_secret};
pub use terminal::{
    close_session_terminals, close_terminal, list_terminal_shells, open_terminal, resize_terminal,
    write_terminal,
};
