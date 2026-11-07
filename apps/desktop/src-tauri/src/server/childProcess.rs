use std::io;
use std::process::Stdio;
use std::time::Duration;

use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::launch::ChildLaunch;
use super::process_tree::NativeProcessTree;

const MAX_CONTROL_LINE_BYTES: usize = 4096;

pub(super) struct SpawnedServer {
    pub child: Child,
    pub ready: mpsc::UnboundedReceiver<u16>,
    pub output: OutputReader,
}

pub(super) struct OutputReader {
    task: JoinHandle<()>,
}

impl OutputReader {
    pub async fn finish(mut self, timeout: Duration) {
        if tokio::time::timeout(timeout, &mut self.task).await.is_err() {
            self.task.abort();
        }
    }
}

pub(super) async fn spawn_server(
    launch: ChildLaunch,
    secret: &str,
    initialize_builtin_characters: bool,
    process_tree: &NativeProcessTree,
) -> Result<SpawnedServer, String> {
    let mut command = base_command(launch, secret);
    super::web_proxy::configure_web_proxy(&mut command);
    if initialize_builtin_characters {
        command.env("EMA_INITIALIZE_BUILTIN_CHARACTERS", "1");
    }
    process_tree.prepare_command(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("spawn server: {error}"))?;
    let pid = child.id().ok_or("server child has no pid")?;
    if let Err(error) = process_tree.attach(pid) {
        let _ = child.start_kill();
        let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
        return Err(error);
    }
    let (ready_sender, ready) = mpsc::unbounded_channel();
    let stdout = child.stdout.take().expect("piped stdout");
    let task = tokio::spawn(async move {
        let _ = read_output(stdout, ready_sender).await;
    });
    Ok(SpawnedServer {
        child,
        ready,
        output: OutputReader { task },
    })
}

fn base_command(launch: ChildLaunch, secret: &str) -> Command {
    let mut command = Command::new(&launch.executable);
    command
        .args(&launch.args)
        .current_dir(&launch.working_dir)
        .stdout(Stdio::piped())
        // GUI 发布版可能没有可继承的控制台句柄. Node 的诊断文件不依赖 stderr.
        .stderr(if cfg!(debug_assertions) {
            Stdio::inherit()
        } else {
            Stdio::null()
        })
        .stdin(Stdio::null())
        .env("EMA_SHARED_SECRET", secret)
        .env(
            "NODE_ENV",
            if cfg!(debug_assertions) {
                "development"
            } else {
                "production"
            },
        );
    if !cfg!(debug_assertions) {
        command.env_remove("NODE_OPTIONS").env_remove("NODE_PATH");
    }
    command
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

// stdout 只用于读取端口通知. 跳过 pnpm 等工具的普通输出, 不收集或保存日志.
pub(super) async fn read_output(
    stream: impl AsyncRead + Unpin,
    ready: mpsc::UnboundedSender<u16>,
) -> io::Result<()> {
    let mut reader = BufReader::new(stream);
    let mut line = Vec::new();
    let mut oversized = false;
    loop {
        let input = reader.fill_buf().await?;
        if input.is_empty() {
            return Ok(());
        }
        let end = input.iter().position(|byte| *byte == b'\n');
        let consumed = end.map_or(input.len(), |position| position + 1);
        if !oversized && line.len() + consumed <= MAX_CONTROL_LINE_BYTES {
            line.extend_from_slice(&input[..consumed]);
        } else {
            oversized = true;
            line.clear();
        }
        reader.consume(consumed);
        if end.is_none() {
            continue;
        }
        if !oversized {
            if let Ok(notification) = serde_json::from_slice::<ReadyNotification>(&line) {
                if notification.jsonrpc == "2.0"
                    && notification.method == "server.ready"
                    && notification.params.port > 0
                {
                    let _ = ready.send(notification.params.port);
                }
            }
        }
        line.clear();
        oversized = false;
    }
}

#[cfg(test)]
#[path = "../../tests/processes/childProcess.rs"]
mod tests;
