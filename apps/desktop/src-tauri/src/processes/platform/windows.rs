// 使用单一 Windows Job Object 持有并回收 Server 及其派生进程.
use std::sync::Arc;
use std::time::Duration;

use tokio::process::{Child, Command};
use tokio::time::timeout;
use win32job::{ExtendedLimitInfo, Job};
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

#[derive(Clone)]
pub struct NativeProcessTree {
    job: Arc<Job>,
}

impl NativeProcessTree {
    pub fn new() -> Result<Self, String> {
        let mut info = ExtendedLimitInfo::new();
        info.limit_kill_on_job_close();
        let job = Job::create_with_limit_info(&info)
            .map_err(|error| format!("create Windows Job Object: {error}"))?;
        Ok(Self { job: Arc::new(job) })
    }

    pub fn prepare_command(&self, command: &mut Command) {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    pub fn attach(&self, pid: u32) -> Result<(), String> {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        };

        let handle = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
        if handle.is_null() {
            return Err(format!("OpenProcess(pid={pid}) failed"));
        }
        let result = self
            .job
            .assign_process(handle as isize)
            .map_err(|error| format!("assign pid {pid} to Job Object: {error}"));
        unsafe { CloseHandle(handle) };
        result
    }

    pub async fn terminate(&self, child: &mut Child, label: &str) {
        if let Some(pid) = child.id() {
            let mut command = Command::new("taskkill");
            // GUI 发布版没有可继承的控制台, 清理命令也必须禁止创建控制台窗口.
            self.prepare_command(&mut command);
            let result = command
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .output()
                .await;
            if let Err(error) = result {
                tracing::warn!(label, pid, %error, "taskkill failed; Job Object remains the exit fallback");
            }
        }
        let _ = child.kill().await;
        let _ = timeout(Duration::from_secs(3), child.wait()).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;

    #[tokio::test]
    async fn termination_reaps_a_running_windows_process() {
        let tree = NativeProcessTree::new().unwrap();
        let mut command = Command::new("cmd.exe");
        // 保持 stdin 打开让进程等待输入, 不依赖网络或机器上安装的开发工具.
        command.args(["/D", "/C", "set /p EMA_TEST_INPUT="]);
        command.stdin(Stdio::piped());
        command.stdout(Stdio::null());
        command.stderr(Stdio::null());
        command.kill_on_drop(true);
        tree.prepare_command(&mut command);
        let mut child = command.spawn().unwrap();
        tree.attach(child.id().unwrap()).unwrap();
        assert!(child.try_wait().unwrap().is_none());

        timeout(Duration::from_secs(10), tree.terminate(&mut child, "test"))
            .await
            .expect("process termination timed out");
        assert!(child.try_wait().unwrap().is_some());
        tree.terminate(&mut child, "test-already-exited").await;
    }
}
