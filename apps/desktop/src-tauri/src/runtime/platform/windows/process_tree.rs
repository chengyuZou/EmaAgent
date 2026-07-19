// 使用单一 Windows Job Object 持有并回收 Core 与 Bridge 整棵进程树。
use std::sync::Arc;
use std::time::Duration;

use tokio::process::{Child, Command};
use tokio::time::timeout;
use win32job::{ExtendedLimitInfo, Job};

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
        command.creation_flags(0x08000000);
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
            let result = Command::new("taskkill")
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
