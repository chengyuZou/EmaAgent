// 启动 Server/Narrative Bridge 子进程并转发标准输出与错误日志。
use std::path::Path;
use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use super::launch::ChildLaunch;
use super::platform::NativeProcessTree;

// 这些参数分别来自进程、认证、数据目录和进程树边界；保持显式比包装成通用配置更清楚。
#[allow(clippy::too_many_arguments)]
pub async fn spawn_narrative(
    launch: ChildLaunch,
    ready_file: &Path,
    secret: &str,
    narrative_dir: &Path,
    process_tree: &NativeProcessTree,
) -> Result<Child, String> {
    let mut command = base_command(launch, ready_file, secret);
    command.env("EMA_NARRATIVE_DIR", narrative_dir);
    spawn(command, "narrative-bridge", process_tree).await
}

pub async fn spawn_server(
    launch: ChildLaunch,
    ready_file: &Path,
    secret: &str,
    narrative_url: Option<&str>,
    process_tree: &NativeProcessTree,
) -> Result<Child, String> {
    let mut command = base_command(launch, ready_file, secret);
    if let Some(url) = narrative_url {
        command.env("EMA_NARRATIVE_BRIDGE_URL", url);
    }
    spawn(command, "server", process_tree).await
}

fn base_command(launch: ChildLaunch, ready_file: &Path, secret: &str) -> Command {
    let mut command = Command::new(&launch.executable);
    command
        .args(&launch.args)
        .current_dir(&launch.working_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .env("EMA_SHARED_SECRET", secret)
        .env("EMA_READY_FILE", ready_file);
    command
}

async fn spawn(
    mut command: Command,
    label: &'static str,
    process_tree: &NativeProcessTree,
) -> Result<Child, String> {
    process_tree.prepare_command(&mut command);
    tracing::info!(label, "launching child process");
    let mut child = command
        .spawn()
        .map_err(|error| format!("spawn {label}: {error}"))?;
    let pid = child
        .id()
        .ok_or_else(|| format!("{label} child has no pid"))?;
    if let Err(error) = process_tree.attach(pid) {
        let _ = child.kill().await;
        return Err(error);
    }
    pipe_stdout(child.stdout.take(), label);
    pipe_stderr(child.stderr.take(), label);
    Ok(child)
}

fn pipe_stdout(stdout: Option<tokio::process::ChildStdout>, label: &'static str) {
    let Some(stdout) = stdout else { return };
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            tracing::debug!(label, %line, "child stdout");
        }
    });
}

fn pipe_stderr(stderr: Option<tokio::process::ChildStderr>, label: &'static str) {
    let Some(stderr) = stderr else { return };
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let normalized = line.trim_start();
            if normalized.starts_with("INFO:") {
                tracing::debug!(label, %line, "child stderr");
            } else if normalized.starts_with("ERROR:") || normalized.starts_with("CRITICAL:") {
                tracing::error!(label, %line, "child stderr");
            } else {
                tracing::warn!(label, %line, "child stderr");
            }
        }
    });
}
