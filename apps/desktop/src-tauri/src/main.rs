// 防止 Windows 平台下的控制台窗口弹出, 仅在 release 模式下生效。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ema_desktop_lib::run();
}
