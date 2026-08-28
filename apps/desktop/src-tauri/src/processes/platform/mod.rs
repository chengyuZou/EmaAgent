// 选择当前操作系统的进程树启动与退出方式。
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
pub use unix::NativeProcessTree;
#[cfg(windows)]
pub use windows::NativeProcessTree;
