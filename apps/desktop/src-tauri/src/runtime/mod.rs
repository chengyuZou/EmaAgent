// 暴露桌面运行时生命周期 Facade 及其稳定状态类型。
mod process;
mod readiness;
mod resources;
mod supervisor;
mod types;

pub mod platform;

pub use supervisor::DesktopRuntimeSupervisor;
pub use types::RuntimeSnapshot;
