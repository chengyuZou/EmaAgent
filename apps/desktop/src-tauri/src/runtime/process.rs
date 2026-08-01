// 启动受监管的 LocalHost/Bridge 子进程并转发其标准输出与错误日志。
use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use super::platform::NativeProcessTree;
use super::resources::ServiceLaunch;
use super::types::RuntimeService;

pub async fn spawn_service(
    service: RuntimeService,
    launch: ServiceLaunch,
    ready_file: &Path,
    nonce: &str,
    secret: &str,
    credential_master_key: &str,
    narrative_dir: Option<PathBuf>,
    process_tree: &NativeProcessTree,
) -> Result<(Child, u32), String> {
    let mut command = Command::new(&launch.executable);
    command
        .args(&launch.args)
        .current_dir(&launch.working_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .env("EMA_SHARED_SECRET", secret)
        .env("EMA_CREDENTIAL_MASTER_KEY", credential_master_key)
        .env("EMA_READY_FILE", ready_file)
        .env("EMA_RUNTIME_NONCE", nonce)
        .env("EMA_RUNTIME_PROTOCOL_VERSION", "1");
    if service == RuntimeService::Bridge {
        command.env("EMA_DATA_DIR", profile_directory());
    }
    if let Some(path) = narrative_dir {
        command.env("EMA_NARRATIVE_DIR", path);
    }
    process_tree.prepare_command(&mut command);

    tracing::info!(
        service = service.as_str(),
        executable = %launch.executable.display(),
        cwd = %launch.working_dir.display(),
        "launching runtime service",
    );
    let mut child = command
        .spawn()
        .map_err(|error| format!("spawn {}: {error}", service.as_str()))?;
    let pid = child
        .id()
        .ok_or_else(|| format!("{} child has no pid", service.as_str()))?;
    if let Err(error) = process_tree.attach(pid) {
        let _ = child.kill().await;
        return Err(error);
    }
    pipe_stdout(child.stdout.take(), service);
    pipe_stderr(child.stderr.take(), service);
    Ok((child, pid))
}

fn profile_directory() -> PathBuf {
    if let Ok(path) = std::env::var("EMA_DATA_DIR") {
        return PathBuf::from(path);
    }
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".ema-agent")
}

fn pipe_stdout(stdout: Option<tokio::process::ChildStdout>, service: RuntimeService) {
    let Some(stdout) = stdout else { return };
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            tracing::debug!(service = service.as_str(), %line, "runtime stdout");
        }
        // 主动退出与子进程自然退出都会关闭管道；异常终态由 Supervisor 的
        // 进程监视器判断，不能仅凭 EOF 向用户显示黄色警告。
        tracing::debug!(service = service.as_str(), "runtime stdout closed");
    });
}

fn pipe_stderr(stderr: Option<tokio::process::ChildStderr>, service: RuntimeService) {
    let Some(stderr) = stderr else { return };
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            // Uvicorn 按惯例把普通 INFO 生命周期日志写到 stderr；按内容还原级别，
            // 避免正常启动和退出在 Desktop 终端里伪装成黄色故障。
            let normalized = line.trim_start();
            if normalized.starts_with("INFO:") {
                tracing::debug!(service = service.as_str(), %line, "runtime stderr");
            } else if normalized.starts_with("ERROR:") || normalized.starts_with("CRITICAL:") {
                tracing::error!(service = service.as_str(), %line, "runtime stderr");
            } else {
                tracing::warn!(service = service.as_str(), %line, "runtime stderr");
            }
        }
    });
}
