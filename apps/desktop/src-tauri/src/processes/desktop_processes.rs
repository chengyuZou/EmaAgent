// 启动和监控 Server 子进程, 向 WebView 提供当前端口和认证信息.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rand::{rngs::OsRng, RngCore};
use tauri::AppHandle;
use tokio::process::Child;
use tokio::sync::{mpsc, Mutex, RwLock};

use super::child::spawn_server;
use super::launch::resolve_server_launch;
use super::platform::NativeProcessTree;
use super::ready::wait_for_ready;
use crate::bundled_data::prepare_builtin_characters;

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
    process_tree: NativeProcessTree,
}

impl DesktopProcesses {
    pub fn new() -> Result<Self, String> {
        Ok(Self(Arc::new(Inner {
            stopping: AtomicBool::new(false),
            operation: Mutex::new(()),
            state: RwLock::new(State::Stopped),
            server: Mutex::new(None),
            process_tree: NativeProcessTree::new()?,
        })))
    }

    pub async fn start(&self, app: AppHandle) -> Result<(), String> {
        let _operation = self.0.operation.lock().await;
        // 此时如果不是 Stopped 状态, 说明已经在启动中或者已经启动完成, 不需要重复启动.
        if !matches!(*self.0.state.read().await, State::Stopped) {
            return Ok(());
        }
        self.0.stopping.store(false, Ordering::Release);
        *self.0.state.write().await = State::Starting;
        let startup_started = Instant::now();

        let initialize_builtin_characters = match prepare_builtin_characters(&app).await {
            Ok(value) => value,
            Err(error) => return self.fail_server_start(error).await,
        };
        let secret = generate_shared_secret();
        let server_launch = match resolve_server_launch(&app) {
            Ok(launch) => launch,
            Err(error) => return self.fail_server_start(error).await,
        };
        let (server, mut ready) = match spawn_server(
            server_launch,
            &secret,
            initialize_builtin_characters,
            &self.0.process_tree,
        )
        .await
        {
            Ok(result) => result,
            Err(error) => return self.fail_server_start(error).await,
        };
        *self.0.server.lock().await = Some(server);
        let port = match wait_for_ready(
            "server",
            READY_TIMEOUT,
            &self.0.stopping,
            &self.0.server,
            &mut ready,
        )
        .await
        {
            Ok(port) => port,
            Err(error) => return self.fail_server_start(error).await,
        };
        let connection = ServerConnection { port, secret };
        *self.0.state.write().await = State::Ready(connection.clone());
        self.watch_server_ready(ready);
        self.watch_children();
        tracing::info!(port, duration_s = %format!("{:.3}", startup_started.elapsed().as_secs_f64()), "Server ready");
        Ok(())
    }

    pub async fn shutdown(&self) {
        self.0.stopping.store(true, Ordering::Release);
        let _operation = self.0.operation.lock().await;
        self.terminate_server().await;
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

    fn watch_server_ready(&self, mut ready: mpsc::UnboundedReceiver<u16>) {
        let processes = self.clone();
        tokio::spawn(async move {
            while let Some(port) = ready.recv().await {
                if processes.0.stopping.load(Ordering::Acquire) {
                    return;
                }
                let connection = match processes.0.state.read().await.clone() {
                    State::Ready(mut connection) => {
                        connection.port = port;
                        connection
                    }
                    _ => return,
                };
                *processes.0.state.write().await = State::Ready(connection.clone());
            }
        });
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
                    tracing::error!(%status, "Server exited unexpectedly");
                    return;
                }
            }
        });
    }

    async fn fail_server_start(&self, error: String) -> Result<(), String> {
        tracing::error!(%error, "Server startup failed");
        self.0.stopping.store(true, Ordering::Release);
        *self.0.state.write().await = State::Failed;
        self.terminate_server().await;
        Err(error)
    }

    async fn terminate_server(&self) {
        if let Some(mut child) = self.0.server.lock().await.take() {
            self.0.process_tree.terminate(&mut child, "server").await;
        }
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

fn generate_shared_secret() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
