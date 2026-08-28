// 依次启动 Narrative Bridge 与 Server，并在桌面退出时回收两个子进程。
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rand::{rngs::OsRng, RngCore};
use tauri::AppHandle;
use tokio::process::Child;
use tokio::sync::{Mutex, RwLock};

use super::child::{spawn_narrative, spawn_server};
use super::launch::{resolve_narrative_launch, resolve_server_launch, ChildLaunch};
use super::platform::NativeProcessTree;
use super::ready::wait_for_ready;
use crate::narrative_data::prepare_narrative_data;

const READY_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug)]
pub(crate) struct ServerConnection {
    pub(crate) port: u16,
    pub(crate) secret: String,
}

#[derive(Clone)]
pub struct DesktopProcesses(Arc<Inner>);

#[derive(Clone)]
enum State {
    Stopped,
    Starting,
    Ready(ServerConnection),
    Failed,
}

struct Inner {
    stopping: AtomicBool,
    operation: Mutex<()>,
    state: RwLock<State>,
    server: Mutex<Option<Child>>,
    narrative: Mutex<Option<Child>>,
    run_dir: Mutex<Option<PathBuf>>,
    process_tree: NativeProcessTree,
}

impl DesktopProcesses {
    pub fn new() -> Result<Self, String> {
        Ok(Self(Arc::new(Inner {
            stopping: AtomicBool::new(false),
            operation: Mutex::new(()),
            state: RwLock::new(State::Stopped),
            server: Mutex::new(None),
            narrative: Mutex::new(None),
            run_dir: Mutex::new(None),
            process_tree: NativeProcessTree::new()?,
        })))
    }

    pub async fn start(&self, app: AppHandle) -> Result<(), String> {
        let _operation = self.0.operation.lock().await;
        if !matches!(*self.0.state.read().await, State::Stopped) {
            return Ok(());
        }

        self.0.stopping.store(false, Ordering::Release);
        *self.0.state.write().await = State::Starting;

        let run_dir = run_directory();
        if let Err(error) = prepare_run_directory(&run_dir).await {
            *self.0.state.write().await = State::Failed;
            return Err(error);
        }
        *self.0.run_dir.lock().await = Some(run_dir.clone());

        let secret = generate_shared_secret();
        let narrative_url = self.try_start_narrative(&app, &run_dir, &secret).await;

        if self.0.stopping.load(Ordering::Acquire) {
            self.stop_children().await;
            *self.0.state.write().await = State::Stopped;
            return Err("desktop startup cancelled".to_string());
        }

        let server_launch = match resolve_server_launch(&app) {
            Ok(launch) => launch,
            Err(error) => return self.fail_server_start(error).await,
        };
        let server_ready = run_dir.join("server.ready.json");
        let server = match spawn_server(
            server_launch,
            &server_ready,
            &secret,
            narrative_url.as_deref(),
            &self.0.process_tree,
        )
        .await
        {
            Ok(result) => result,
            Err(error) => return self.fail_server_start(error).await,
        };
        *self.0.server.lock().await = Some(server);

        let ready =
            match wait_for_ready(&server_ready, "server", READY_TIMEOUT, &self.0.stopping).await {
                Ok(ready) => ready,
                Err(error) => return self.fail_server_start(error).await,
            };

        let connection = ServerConnection {
            port: ready,
            secret,
        };
        *self.0.state.write().await = State::Ready(connection);
        self.watch_children();
        tracing::info!(port = ready, "desktop child processes ready");
        Ok(())
    }

    pub async fn shutdown(&self) {
        self.0.stopping.store(true, Ordering::Release);
        let _operation = self.0.operation.lock().await;
        self.stop_children().await;
        if let Some(directory) = self.0.run_dir.lock().await.take() {
            if let Err(error) = tokio::fs::remove_dir_all(&directory).await {
                if error.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(path = %directory.display(), %error, "remove child process directory failed");
                }
            }
        }
        *self.0.state.write().await = State::Stopped;
    }

    pub(crate) async fn wait_for_server(&self, max_wait: Duration) -> Option<ServerConnection> {
        let deadline = tokio::time::Instant::now() + max_wait;
        loop {
            match self.0.state.read().await.clone() {
                State::Ready(connection) => return Some(connection),
                State::Failed | State::Stopped => return None,
                State::Starting => {}
            }
            if tokio::time::Instant::now() >= deadline {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    async fn try_start_narrative(
        &self,
        app: &AppHandle,
        run_dir: &Path,
        secret: &str,
    ) -> Option<String> {
        let narrative_dir = match prepare_narrative_data(app).await {
            Ok(path) => path,
            Err(error) => {
                tracing::warn!(%error, "Narrative data unavailable");
                return None;
            }
        };
        let launch = match resolve_narrative_launch(app) {
            Ok(launch) => launch,
            Err(error) => {
                tracing::warn!(%error, "Narrative Bridge executable unavailable");
                return None;
            }
        };
        match self
            .start_narrative(launch, run_dir, secret, &narrative_dir)
            .await
        {
            Ok(port) => Some(format!("http://127.0.0.1:{port}")),
            Err(error) => {
                self.terminate_narrative().await;
                tracing::warn!(%error, "Narrative Bridge unavailable");
                None
            }
        }
    }

    async fn start_narrative(
        &self,
        launch: ChildLaunch,
        run_dir: &Path,
        secret: &str,
        narrative_dir: &Path,
    ) -> Result<u16, String> {
        let ready_file = run_dir.join("narrative-bridge.ready.json");
        let child = spawn_narrative(
            launch,
            &ready_file,
            secret,
            narrative_dir,
            &self.0.process_tree,
        )
        .await?;
        *self.0.narrative.lock().await = Some(child);
        let ready = wait_for_ready(
            &ready_file,
            "narrative-bridge",
            READY_TIMEOUT,
            &self.0.stopping,
        )
        .await?;
        tracing::info!(port = ready, "Narrative Bridge ready");
        Ok(ready)
    }

    async fn fail_server_start(&self, error: String) -> Result<(), String> {
        self.stop_children().await;
        *self.0.state.write().await = State::Failed;
        Err(error)
    }

    async fn stop_children(&self) {
        self.terminate_server().await;
        self.terminate_narrative().await;
    }

    async fn terminate_server(&self) {
        let mut child = self.0.server.lock().await;
        if let Some(mut child) = child.take() {
            self.0.process_tree.terminate(&mut child, "server").await;
        }
    }

    async fn terminate_narrative(&self) {
        let mut child = self.0.narrative.lock().await;
        if let Some(mut child) = child.take() {
            self.0
                .process_tree
                .terminate(&mut child, "narrative-bridge")
                .await;
        }
    }

    fn watch_children(&self) {
        let processes = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(500)).await;
                if processes.0.stopping.load(Ordering::Acquire) {
                    return;
                }

                if let Some(status) = poll_exit(&processes.0.server).await {
                    *processes.0.state.write().await = State::Failed;
                    processes.terminate_narrative().await;
                    tracing::error!(%status, "Server exited unexpectedly");
                    return;
                }
                if let Some(status) = poll_exit(&processes.0.narrative).await {
                    tracing::warn!(%status, "Narrative Bridge exited unexpectedly");
                }
            }
        });
    }
}

async fn poll_exit(slot: &Mutex<Option<Child>>) -> Option<std::process::ExitStatus> {
    let mut guard = slot.lock().await;
    let child = guard.as_mut()?;
    match child.try_wait() {
        Ok(Some(status)) => {
            guard.take();
            Some(status)
        }
        Ok(None) => None,
        Err(error) => {
            tracing::warn!(%error, "poll child process failed");
            None
        }
    }
}

fn run_directory() -> PathBuf {
    std::env::temp_dir()
        .join("ema-agent-processes")
        .join(std::process::id().to_string())
}

fn generate_shared_secret() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

async fn prepare_run_directory(path: &Path) -> Result<(), String> {
    if let Err(error) = tokio::fs::remove_dir_all(path).await {
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err(format!(
                "clear process directory {}: {error}",
                path.display()
            ));
        }
    }
    tokio::fs::create_dir_all(path)
        .await
        .map_err(|error| format!("create process directory {}: {error}", path.display()))
}
