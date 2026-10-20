mod child;
mod desktop_processes;
mod launch;
mod platform;
mod ready;
#[path = "webProxy.rs"]
mod web_proxy;

pub use desktop_processes::DesktopProcesses;
pub(crate) use desktop_processes::SERVER_READY_TIMEOUT;
