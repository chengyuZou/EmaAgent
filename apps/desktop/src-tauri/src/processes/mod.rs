// 暴露 Desktop 启动和停止两个固定子进程的唯一入口。
mod child;
mod desktop_processes;
mod launch;
mod platform;
mod ready;

pub use desktop_processes::DesktopProcesses;
