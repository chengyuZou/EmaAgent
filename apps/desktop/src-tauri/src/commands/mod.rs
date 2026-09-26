// 汇总桌面宿主暴露给 WebView 的 Tauri commands。
mod browser;
mod desktop;
mod fonts;
mod narrative;
mod server;
mod terminal;

pub use browser::{
    browser_back, browser_forward, close_browser, navigate_browser, open_browser, reload_browser,
    set_browser_bounds, set_browser_visible,
};
pub use desktop::{
    open_path, open_window, quit_app, read_draft_image, report_live2d_diagnostic,
    set_always_on_top, set_passthrough,
};
pub use fonts::list_system_fonts;
pub use narrative::{get_narrative_port, start_narrative, wait_narrative_exit};
pub use server::{get_server_port, get_server_secret};
pub use terminal::{
    close_session_terminals, close_terminal, open_terminal, resize_terminal, write_terminal,
};
