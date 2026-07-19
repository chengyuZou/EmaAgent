// 选择当前操作系统的进程树与子进程启动实现。
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
pub use linux::NativeProcessTree;
#[cfg(target_os = "macos")]
pub use macos::NativeProcessTree;
#[cfg(target_os = "windows")]
pub use windows::NativeProcessTree;

#[cfg(unix)]
mod unix_process_tree;
