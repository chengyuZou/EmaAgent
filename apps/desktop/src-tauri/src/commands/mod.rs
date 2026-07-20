// 汇总桌面宿主暴露给 WebView 的 Tauri commands。
mod runtime;
mod windows;

pub use runtime::{get_runtime_snapshot, get_sidecar_port, get_sidecar_secret};
pub use windows::{open_window, quit_app, set_always_on_top, set_passthrough};
