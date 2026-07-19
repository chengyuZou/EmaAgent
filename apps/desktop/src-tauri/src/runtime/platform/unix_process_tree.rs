// 为 macOS 与 Linux 提供独立进程组、TERM/KILL 升级和子进程回收。
use std::time::Duration;

use tokio::process::{Child, Command};
use tokio::time::timeout;

#[derive(Clone, Default)]
pub struct NativeProcessTree;

impl NativeProcessTree {
    pub fn new() -> Result<Self, String> {
        Ok(Self)
    }

    pub fn prepare_command(&self, command: &mut Command) {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }

    pub fn attach(&self, _pid: u32) -> Result<(), String> {
        Ok(())
    }

    pub async fn terminate(&self, child: &mut Child, label: &str) {
        let Some(pid) = child.id() else { return };
        let group = -(pid as i32);
        unsafe {
            libc::kill(group, libc::SIGTERM);
        }
        if timeout(Duration::from_secs(3), child.wait()).await.is_ok() {
            return;
        }
        tracing::warn!(
            label,
            pid,
            "process group ignored SIGTERM; escalating to SIGKILL"
        );
        unsafe {
            libc::kill(group, libc::SIGKILL);
        }
        let _ = child.kill().await;
        let _ = timeout(Duration::from_secs(3), child.wait()).await;
    }
}
