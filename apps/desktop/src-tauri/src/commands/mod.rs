// 汇总桌面宿主暴露给 WebView 的 Tauri commands。
mod desktop;
mod server;

pub use desktop::{open_window, quit_app, set_always_on_top, set_passthrough};
pub use server::{get_server_port, get_server_secret};
