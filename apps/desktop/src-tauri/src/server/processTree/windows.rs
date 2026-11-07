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

    pub async fn terminate(&self, child: &mut Child) {
        if let Some(pid) = child.id() {
            let mut command = Command::new("taskkill");
            // GUI 发布版没有可继承的控制台, 清理命令也必须禁止创建控制台窗口.
            self.prepare_command(&mut command);
            command
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .kill_on_drop(true);
            let _ = timeout(Duration::from_secs(3), command.output()).await;
        }
        let _ = child.start_kill();
        let _ = timeout(Duration::from_secs(3), child.wait()).await;
    }
}

#[cfg(test)]
#[path = "../../../tests/processes/processTreeWindows.rs"]
mod tests;
