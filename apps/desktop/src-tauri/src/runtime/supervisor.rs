// 统一编排 Bridge/Core 启动、结构化就绪、状态发布和可靠退出。
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rand::distributions::Alphanumeric;
use rand::{thread_rng, Rng};
use tauri::AppHandle;
use tokio::process::Child;
use tokio::sync::{Mutex, RwLock};

use super::platform::NativeProcessTree;
use super::process::spawn_service;
use super::readiness::wait_for_ready;
use super::resources::{resolve_narrative_dir, resolve_service_launch, ServiceLaunch};
use super::types::{RuntimePhase, RuntimeService, RuntimeSnapshot, ServicePhase, ServiceSnapshot};

const CORE_READY_TIMEOUT: Duration = Duration::from_secs(30);
const BRIDGE_READY_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct DesktopRuntimeSupervisor(Arc<Inner>);

struct Inner {
    generation: AtomicU64,
    shutdown_requested: AtomicBool,
    operation: Mutex<()>,
    snapshot: RwLock<RuntimeSnapshot>,
    secret: RwLock<Option<String>>,
    core: Mutex<Option<Child>>,
    bridge: Mutex<Option<Child>>,
    runtime_dir: Mutex<Option<PathBuf>>,
    process_tree: NativeProcessTree,
    credential_master_key: String,
}

impl DesktopRuntimeSupervisor {
    pub fn new(credential_master_key: String) -> Result<Self, String> {
        Ok(Self(Arc::new(Inner {
            generation: AtomicU64::new(0),
            shutdown_requested: AtomicBool::new(false),
            operation: Mutex::new(()),
            snapshot: RwLock::new(RuntimeSnapshot::stopped()),
            secret: RwLock::new(None),
            core: Mutex::new(None),
            bridge: Mutex::new(None),
            runtime_dir: Mutex::new(None),
            process_tree: NativeProcessTree::new()?,
            credential_master_key,
        })))
    }

    pub async fn start(&self, app: AppHandle) -> Result<(), String> {
        let _operation = self.0.operation.lock().await;
        let phase = self.0.snapshot.read().await.phase;
        if !matches!(phase, RuntimePhase::Stopped | RuntimePhase::Failed) {
            return Ok(());
        }

        self.0.shutdown_requested.store(false, Ordering::Release);
        let generation = self.0.generation.fetch_add(1, Ordering::AcqRel) + 1;
        let nonce: String = thread_rng()
            .sample_iter(&Alphanumeric)
            .take(32)
            .map(char::from)
            .collect();
        let runtime_dir = runtime_directory(generation, &nonce);
        let secret = crate::credential_key::generate_ephemeral_secret();
        let credential_master_key = self.0.credential_master_key.clone();
        prepare_runtime_directory(&runtime_dir).await?;
        *self.0.runtime_dir.lock().await = Some(runtime_dir.clone());
        *self.0.secret.write().await = Some(secret.clone());
        self.reset_snapshot(generation).await;

        // Bridge 是 Narrative 的可选能力；启动或就绪失败时明确标记 unavailable，
        // Core 和 chat 主链路仍继续启动。
        self.set_runtime_phase(RuntimePhase::StartingBridge, None)
            .await;
        let bridge_ready = runtime_dir.join("bridge.ready.json");
        match resolve_service_launch(&app, RuntimeService::Bridge) {
            Ok(launch) => {
                self.set_service_starting(RuntimeService::Bridge).await;
                let result = match resolve_narrative_dir(&app) {
                    Ok(path) => {
                        self.start_service(
                            RuntimeService::Bridge,
                            launch,
                            &bridge_ready,
                            &nonce,
                            &secret,
                            &credential_master_key,
                            Some(path),
                        )
                        .await
                    }
                    Err(error) => Err(error),
                };
                match result {
                    Ok((pid, port)) => {
                        self.set_service_ready(RuntimeService::Bridge, pid, port)
                            .await
                    }
                    Err(error) => {
                        self.terminate_service(RuntimeService::Bridge).await;
                        self.set_service_unavailable(RuntimeService::Bridge, error.clone())
                            .await;
                        tracing::warn!(%error, "bridge unavailable; narrative mode will degrade");
                    }
                }
            }
            Err(error) => {
                self.set_service_unavailable(RuntimeService::Bridge, error.clone())
                    .await;
                tracing::warn!(%error, "bridge executable unavailable; narrative mode will degrade");
            }
        }

        if self.0.shutdown_requested.load(Ordering::Acquire) {
            return self.finish_cancelled_start().await;
        }

        // Core 是桌面应用必需服务。任何失败都进入 Failed，并回收已经启动的 Bridge。
        self.set_runtime_phase(RuntimePhase::StartingCore, None)
            .await;
        self.set_service_starting(RuntimeService::Core).await;
        let core_ready = runtime_dir.join("core.ready.json");
        let core_launch = match resolve_service_launch(&app, RuntimeService::Core) {
            Ok(launch) => launch,
            Err(error) => return self.fail_core_start(error).await,
        };
        match self
            .start_service(
                RuntimeService::Core,
                core_launch,
                &core_ready,
                &nonce,
                &secret,
                &credential_master_key,
                None,
            )
            .await
        {
            Ok((pid, port)) => {
                self.set_service_ready(RuntimeService::Core, pid, port)
                    .await;
                self.set_runtime_phase(RuntimePhase::Ready, None).await;
                self.spawn_exit_monitor(generation);
                tracing::info!(generation, port, "desktop runtime ready");
                Ok(())
            }
            Err(error) => self.fail_core_start(error).await,
        }
    }

    pub async fn shutdown(&self) {
        // 先发布取消请求，唤醒仍在 readiness 轮询中的 start；再串行取得操作锁。
        self.0.shutdown_requested.store(true, Ordering::Release);
        let _operation = self.0.operation.lock().await;
        self.set_runtime_phase(RuntimePhase::Stopping, None).await;

        // Core 依赖 Bridge，退出时先停上游请求入口，再停计算 Bridge。
        self.terminate_service(RuntimeService::Core).await;
        self.terminate_service(RuntimeService::Bridge).await;

        if let Some(directory) = self.0.runtime_dir.lock().await.take() {
            if let Err(error) = tokio::fs::remove_dir_all(&directory).await {
                if error.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(path = %directory.display(), %error, "remove runtime directory failed");
                }
            }
        }
        *self.0.secret.write().await = None;
        let generation = self.0.generation.load(Ordering::Acquire);
        *self.0.snapshot.write().await = RuntimeSnapshot {
            generation,
            ..RuntimeSnapshot::stopped()
        };
    }

    pub async fn snapshot(&self) -> RuntimeSnapshot {
        self.0.snapshot.read().await.clone()
    }

    pub async fn get_secret(&self) -> Option<String> {
        self.0.secret.read().await.clone()
    }

    pub async fn wait_for_port(&self, max_wait: Duration) -> Option<u16> {
        let deadline = tokio::time::Instant::now() + max_wait;
        loop {
            let snapshot = self.0.snapshot.read().await;
            if let Some(port) = snapshot.core.port {
                return Some(port);
            }
            if snapshot.phase == RuntimePhase::Failed {
                return None;
            }
            drop(snapshot);
            if tokio::time::Instant::now() >= deadline {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    async fn start_service(
        &self,
        service: RuntimeService,
        launch: ServiceLaunch,
        ready_file: &Path,
        nonce: &str,
        secret: &str,
        credential_master_key: &str,
        narrative_dir: Option<PathBuf>,
    ) -> Result<(u32, u16), String> {
        let _ = tokio::fs::remove_file(ready_file).await;
        let (child, pid) = spawn_service(
            service,
            launch,
            ready_file,
            nonce,
            secret,
            credential_master_key,
            narrative_dir,
            &self.0.process_tree,
        )
        .await?;

        let slot = self.child_slot(service);
        *slot.lock().await = Some(child);
        if self.0.shutdown_requested.load(Ordering::Acquire) {
            return Err(format!("{} startup cancelled", service.as_str()));
        }

        let timeout = match service {
            RuntimeService::Core => CORE_READY_TIMEOUT,
            RuntimeService::Bridge => BRIDGE_READY_TIMEOUT,
        };
        let record = wait_for_ready(
            ready_file,
            service,
            pid,
            nonce,
            timeout,
            &self.0.shutdown_requested,
        )
        .await?;
        Ok((record.pid, record.port))
    }

    async fn terminate_service(&self, service: RuntimeService) {
        let slot = self.child_slot(service);
        let mut guard = slot.lock().await;
        let Some(mut child) = guard.take() else {
            return;
        };
        self.0
            .process_tree
            .terminate(&mut child, service.as_str())
            .await;
    }

    async fn fail_core_start(&self, error: String) -> Result<(), String> {
        self.terminate_service(RuntimeService::Core).await;
        self.terminate_service(RuntimeService::Bridge).await;
        self.set_service_failed(RuntimeService::Core, error.clone())
            .await;
        self.set_runtime_phase(RuntimePhase::Failed, Some(error.clone()))
            .await;
        Err(error)
    }

    fn spawn_exit_monitor(&self, generation: u64) {
        let supervisor = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(500)).await;
                if supervisor.0.shutdown_requested.load(Ordering::Acquire)
                    || supervisor.0.generation.load(Ordering::Acquire) != generation
                {
                    return;
                }

                if let Some(status) = supervisor.poll_exit(RuntimeService::Core).await {
                    let error = format!("core exited unexpectedly: {status}");
                    supervisor
                        .set_service_failed(RuntimeService::Core, error.clone())
                        .await;
                    supervisor
                        .set_runtime_phase(RuntimePhase::Failed, Some(error.clone()))
                        .await;
                    supervisor.terminate_service(RuntimeService::Bridge).await;
                    tracing::error!(generation, %error, "desktop runtime failed");
                    return;
                }

                if let Some(status) = supervisor.poll_exit(RuntimeService::Bridge).await {
                    let error = format!("bridge exited unexpectedly: {status}");
                    supervisor
                        .set_service_unavailable(RuntimeService::Bridge, error.clone())
                        .await;
                    tracing::warn!(generation, %error, "narrative bridge became unavailable");
                }
            }
        });
    }

    async fn poll_exit(&self, service: RuntimeService) -> Option<std::process::ExitStatus> {
        let slot = self.child_slot(service);
        let mut guard = slot.lock().await;
        let child = guard.as_mut()?;
        match child.try_wait() {
            Ok(Some(status)) => {
                guard.take();
                Some(status)
            }
            Ok(None) => None,
            Err(error) => {
                tracing::warn!(service = service.as_str(), %error, "poll runtime process failed");
                None
            }
        }
    }

    fn child_slot(&self, service: RuntimeService) -> &Mutex<Option<Child>> {
        match service {
            RuntimeService::Core => &self.0.core,
            RuntimeService::Bridge => &self.0.bridge,
        }
    }

    async fn finish_cancelled_start(&self) -> Result<(), String> {
        self.terminate_service(RuntimeService::Core).await;
        self.terminate_service(RuntimeService::Bridge).await;
        Err("desktop runtime startup cancelled".to_string())
    }

    async fn reset_snapshot(&self, generation: u64) {
        *self.0.snapshot.write().await = RuntimeSnapshot {
            generation,
            phase: RuntimePhase::Stopped,
            core: ServiceSnapshot::stopped(),
            bridge: ServiceSnapshot::stopped(),
            last_error: None,
        };
    }

    async fn set_runtime_phase(&self, phase: RuntimePhase, error: Option<String>) {
        let mut snapshot = self.0.snapshot.write().await;
        snapshot.phase = phase;
        snapshot.last_error = error;
    }

    async fn set_service_starting(&self, service: RuntimeService) {
        self.set_service_snapshot(
            service,
            ServiceSnapshot {
                phase: ServicePhase::Starting,
                pid: None,
                port: None,
                error: None,
            },
        )
        .await;
    }

    async fn set_service_ready(&self, service: RuntimeService, pid: u32, port: u16) {
        self.set_service_snapshot(
            service,
            ServiceSnapshot {
                phase: ServicePhase::Ready,
                pid: Some(pid),
                port: Some(port),
                error: None,
            },
        )
        .await;
    }

    async fn set_service_unavailable(&self, service: RuntimeService, error: String) {
        self.set_service_snapshot(
            service,
            ServiceSnapshot {
                phase: ServicePhase::Unavailable,
                pid: None,
                port: None,
                error: Some(error),
            },
        )
        .await;
    }

    async fn set_service_failed(&self, service: RuntimeService, error: String) {
        self.set_service_snapshot(
            service,
            ServiceSnapshot {
                phase: ServicePhase::Failed,
                pid: None,
                port: None,
                error: Some(error),
            },
        )
        .await;
    }

    async fn set_service_snapshot(&self, service: RuntimeService, value: ServiceSnapshot) {
        let mut snapshot = self.0.snapshot.write().await;
        match service {
            RuntimeService::Core => snapshot.core = value,
            RuntimeService::Bridge => snapshot.bridge = value,
        }
    }
}

fn runtime_directory(generation: u64, nonce: &str) -> PathBuf {
    std::env::temp_dir().join("ema-agent-runtime").join(format!(
        "{}-{generation}-{}",
        std::process::id(),
        &nonce[..8]
    ))
}

async fn prepare_runtime_directory(path: &Path) -> Result<(), String> {
    if let Err(error) = tokio::fs::remove_dir_all(path).await {
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err(format!(
                "clear runtime directory {}: {error}",
                path.display()
            ));
        }
    }
    tokio::fs::create_dir_all(path)
        .await
        .map_err(|error| format!("create runtime directory {}: {error}", path.display()))
}
