// 并行启动 Server 与 Narrative, 并把每次 Python 实际监听端口接入当前 Server.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rand::{rngs::OsRng, RngCore};
use serde_json::json;
use tauri::AppHandle;
use tokio::process::Child;
use tokio::sync::{mpsc, Mutex, RwLock};

use super::child::{spawn_narrative, spawn_server};
use super::launch::{resolve_narrative_launch, resolve_server_launch};
use super::platform::NativeProcessTree;
use super::ready::wait_for_ready;
use crate::bundled_data::{prepare_builtin_characters, prepare_narrative_data};
use crate::desktop::settings::read_start_narrative_on_launch;

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
    narrative_operation: Mutex<()>,
    state: RwLock<State>,
    server: Mutex<Option<Child>>,
    narrative: Mutex<Option<Child>>,
    narrative_port: RwLock<Option<u16>>,
    process_tree: NativeProcessTree,
}

impl DesktopProcesses {
    pub fn new() -> Result<Self, String> {
        Ok(Self(Arc::new(Inner {
            stopping: AtomicBool::new(false),
            operation: Mutex::new(()),
            narrative_operation: Mutex::new(()),
            state: RwLock::new(State::Stopped),
            server: Mutex::new(None),
            narrative: Mutex::new(None),
            narrative_port: RwLock::new(None),
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
        let start_narrative = read_start_narrative_on_launch().unwrap_or_else(|error| {
            tracing::warn!(%error, "read Narrative launch preference failed; using enabled default");
            true
        });

        if start_narrative {
            let processes = self.clone();
            let narrative_app = app.clone();
            let narrative_secret = secret.clone();
            tokio::spawn(async move {
                if let Err(error) = processes
                    .start_narrative(&narrative_app, &narrative_secret)
                    .await
                {
                    tracing::warn!(%error, "Narrative Bridge unavailable at startup");
                }
            });
        } else {
            tracing::info!("Narrative Bridge disabled for this launch");
        }

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

    pub async fn start_narrative_manually(&self, app: AppHandle) -> Result<u16, String> {
        let connection = self
            .wait_for_server(READY_TIMEOUT)
            .await
            .ok_or_else(|| "Server is not ready".to_string())?;
        self.start_narrative(&app, &connection.secret).await
    }

    pub async fn narrative_port(&self) -> Option<u16> {
        *self.0.narrative_port.read().await
    }

    pub async fn wait_narrative_exit(&self) -> Result<(), String> {
        loop {
            let mut child = self.0.narrative.lock().await;
            let status = match child.as_mut() {
                None => None,
                Some(process) => match process.try_wait() {
                    Ok(status) => status,
                    Err(error) => return Err(format!("wait for Narrative exit: {error}")),
                },
            };
            if let Some(status) = status {
                child.take();
                drop(child);
                *self.0.narrative_port.write().await = None;
                tracing::info!(%status, "Narrative Bridge exited");
                return Ok(());
            }
            if child.is_none() {
                drop(child);
                *self.0.narrative_port.write().await = None;
                return Ok(());
            }
            drop(child);
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    pub async fn shutdown(&self) {
        self.0.stopping.store(true, Ordering::Release);
        let _operation = self.0.operation.lock().await;
        self.stop_children().await;
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

    async fn start_narrative(&self, app: &AppHandle, secret: &str) -> Result<u16, String> {
        let _operation = self.0.narrative_operation.lock().await;
        if self.0.stopping.load(Ordering::Acquire) {
            return Err("desktop is shutting down".to_string());
        }
        if let Some(port) = *self.0.narrative_port.read().await {
            return Ok(port);
        }
        let narrative_dir = prepare_narrative_data(app).await?;
        let launch = resolve_narrative_launch(app)?;
        let (child, mut ready) =
            spawn_narrative(launch, secret, &narrative_dir, &self.0.process_tree).await?;
        *self.0.narrative.lock().await = Some(child);
        let port = match wait_for_ready(
            "narrative-bridge",
            READY_TIMEOUT,
            &self.0.stopping,
            &self.0.narrative,
            &mut ready,
        )
        .await
        {
            Ok(port) => port,
            Err(error) => {
                self.terminate_narrative().await;
                return Err(error);
            }
        };
        let connection = match self.wait_for_server(READY_TIMEOUT).await {
            Some(connection) => connection,
            None => {
                self.terminate_narrative().await;
                return Err("Server did not become ready for Narrative attach".to_string());
            }
        };
        if let Err(error) = self.attach_narrative(&connection, port).await {
            self.terminate_narrative().await;
            if let Err(detach_error) = send_control(&connection, NarrativeControl::Detach).await {
                tracing::warn!(%detach_error, "Narrative detach after failed attach failed");
            }
            return Err(error);
        }
        if let Some(status) = poll_exit(&self.0.narrative).await {
            return Err(format!("Narrative Bridge exited during attach ({status})"));
        }
        *self.0.narrative_port.write().await = Some(port);
        tracing::info!(port, "Narrative Bridge ready");
        Ok(port)
    }

    async fn attach_narrative(&self, server: &ServerConnection, port: u16) -> Result<(), String> {
        send_control(server, NarrativeControl::Attach(port)).await
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
                let _operation = processes.0.narrative_operation.lock().await;
                let narrative_port = *processes.0.narrative_port.read().await;
                if let Some(narrative_port) = narrative_port {
                    if let Err(error) = processes
                        .attach_narrative(&connection, narrative_port)
                        .await
                    {
                        tracing::warn!(%error, "Narrative reattach after Server restart failed");
                    }
                }
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
                    processes.terminate_narrative().await;
                    tracing::error!(%status, "Server exited unexpectedly");
                    return;
                }
                let _operation = processes.0.narrative_operation.lock().await;
                if let Some(status) = poll_exit(&processes.0.narrative).await {
                    *processes.0.narrative_port.write().await = None;
                    let state = processes.0.state.read().await.clone();
                    if let State::Ready(connection) = state {
                        if let Err(error) =
                            send_control(&connection, NarrativeControl::Detach).await
                        {
                            tracing::warn!(%error, "Narrative detach after exit failed");
                        }
                    }
                    tracing::warn!(%status, "Narrative Bridge exited");
                }
            }
        });
    }

    async fn fail_server_start(&self, error: String) -> Result<(), String> {
        tracing::error!(%error, "Server startup failed");
        self.0.stopping.store(true, Ordering::Release);
        *self.0.state.write().await = State::Failed;
        self.stop_children().await;
        Err(error)
    }

    async fn stop_children(&self) {
        self.terminate_server().await;
        let _narrative_operation = self.0.narrative_operation.lock().await;
        self.terminate_narrative().await;
    }

    async fn terminate_server(&self) {
        if let Some(mut child) = self.0.server.lock().await.take() {
            self.0.process_tree.terminate(&mut child, "server").await;
        }
    }

    async fn terminate_narrative(&self) {
        if let Some(mut child) = self.0.narrative.lock().await.take() {
            self.0
                .process_tree
                .terminate(&mut child, "narrative-bridge")
                .await;
        }
        *self.0.narrative_port.write().await = None;
    }
}

enum NarrativeControl {
    Attach(u16),
    Detach,
}

async fn send_control(server: &ServerConnection, control: NarrativeControl) -> Result<(), String> {
    let (method, request) = match control {
        NarrativeControl::Attach(port) => (
            "narrative.attach",
            json!({ "jsonrpc": "2.0", "id": 1, "method": "narrative.attach", "params": { "port": port } }),
        ),
        NarrativeControl::Detach => (
            "narrative.detach",
            json!({ "jsonrpc": "2.0", "id": 1, "method": "narrative.detach" }),
        ),
    };
    let response = reqwest::Client::new()
        .post(format!(
            "http://127.0.0.1:{}/internal/narrative/control",
            server.port
        ))
        .header("X-Ema-Secret", &server.secret)
        .json(&request)
        .timeout(Duration::from_secs(90))
        .send()
        .await
        .map_err(|error| format!("send {method} to Server: {error}"))?;
    let status = response.status();
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("read {method} response: {error}"))?;
    if !status.is_success() || body.get("error").is_some() || body.get("id") != Some(&json!(1)) {
        return Err(format!("Server rejected {method}: {body}"));
    }
    Ok(())
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
