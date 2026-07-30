// 汇总桌面宿主暴露给 WebView 的 Tauri commands。
// 注意:"在…中打开"(list_workspace_openers/open_workspace_with)曾在此设计,
// 经 2026-07-30 拍板推迟到 V1 正式版——枚举到的本机 exe 不可信(同名伪造/注入/路径欺骗),
// 内测版不开放该能力,不要在此恢复 opener 命令。
mod runtime;
mod windows;

pub use runtime::{get_runtime_snapshot, get_sidecar_port, get_sidecar_secret};
pub use windows::{open_window, quit_app, set_always_on_top, set_passthrough};
