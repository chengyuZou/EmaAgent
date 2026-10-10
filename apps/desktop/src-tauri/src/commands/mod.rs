// 汇总桌面宿主暴露给 WebView 的 Tauri commands。
mod browser;
mod desktop;
mod fonts;
mod server;
mod terminal;

pub use browser::{
    browser_back, browser_forward, close_browser, navigate_browser, open_browser, reload_browser,
    set_browser_bounds, set_browser_visible,
};
pub use desktop::{
    get_passthrough, open_path, open_window, quit_app, read_draft_image, report_live2d_diagnostic,
    set_always_on_top, set_passthrough, set_passthrough_controls_hovered, start_pet_pointer,
};
pub use fonts::list_system_fonts;
pub use server::{get_server_port, get_server_secret};
pub use terminal::{
    close_session_terminals, close_terminal, open_terminal, resize_terminal, write_terminal,
};
