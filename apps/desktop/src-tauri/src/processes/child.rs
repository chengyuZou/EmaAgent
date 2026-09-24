// 启动 Server/Narrative Bridge 子进程并转发标准输出与错误日志。
use std::path::Path;
use std::process::Stdio;

use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

use super::launch::ChildLaunch;
use super::platform::NativeProcessTree;

// 这些参数分别来自进程、认证、数据目录和进程树边界；保持显式比包装成通用配置更清楚。
#[allow(clippy::too_many_arguments)]
pub async fn spawn_narrative(
    launch: ChildLaunch,
    secret: &str,
    narrative_dir: &Path,
    process_tree: &NativeProcessTree,
) -> Result<(Child, mpsc::UnboundedReceiver<u16>), String> {
    let mut command = base_command(launch, secret);
    command.env("EMA_NARRATIVE_DIR", narrative_dir);
    spawn(command, "narrative-bridge", process_tree).await
}

pub async fn spawn_server(
    launch: ChildLaunch,
    secret: &str,
    initialize_builtin_characters: bool,
    process_tree: &NativeProcessTree,
) -> Result<(Child, mpsc::UnboundedReceiver<u16>), String> {
    let mut command = base_command(launch, secret);
    if initialize_builtin_characters {
        command.env("EMA_INITIALIZE_BUILTIN_CHARACTERS", "1");
    }
    spawn(command, "server", process_tree).await
}

fn base_command(launch: ChildLaunch, secret: &str) -> Command {
    let mut command = Command::new(&launch.executable);
    command
        .args(&launch.args)
        .current_dir(&launch.working_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .env("EMA_SHARED_SECRET", secret);
    command
}

async fn spawn(
    mut command: Command,
    label: &'static str,
    process_tree: &NativeProcessTree,
) -> Result<(Child, mpsc::UnboundedReceiver<u16>), String> {
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
    tracing::info!(label, pid, "child process spawned");
    let (ready_sender, ready_receiver) = mpsc::unbounded_channel();
    pipe_stdout(child.stdout.take(), label, ready_sender);
    pipe_stderr(child.stderr.take(), label);
    Ok((child, ready_receiver))
}

#[derive(Deserialize)]
struct ReadyNotification {
    jsonrpc: String,
    method: String,
    params: ReadyParams,
}

#[derive(Deserialize)]
struct ReadyParams {
    port: u16,
}

fn pipe_stdout(
    stdout: Option<tokio::process::ChildStdout>,
    label: &'static str,
    ready_sender: mpsc::UnboundedSender<u16>,
) {
    let Some(stdout) = stdout else { return };
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let expected_method = if label == "server" {
                "server.ready"
            } else {
                "narrative.ready"
            };
            if let Ok(message) = serde_json::from_str::<ReadyNotification>(&line) {
                if message.jsonrpc == "2.0"
                    && message.method == expected_method
                    && message.params.port > 0
                {
                    let _ = ready_sender.send(message.params.port);
                    continue;
                }
            }
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
