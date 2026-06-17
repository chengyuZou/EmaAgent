// ── Sidecar lifecycle ──────────────────────────────────────────────────────
//
// Spawns `pnpm --filter @ema-agent/core dev` as a child process. Reads its
// stdout asynchronously, looking for the "listening on http://127.0.0.1:<port>"
// log line to discover which port the sidecar actually bound to (it auto-
// retries 3421→3430 if 3421 is taken).
//
// Wired in lib.rs:
//   - setup()             → tauri::async_runtime::spawn(spawn(...))
//   - WindowEvent::Close  → state.shutdown().await
//
// Dev only for now. Production bundling (sidecar binary inside tauri bundle)
// is deferred to P2.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use regex::Regex;
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, OnceCell};
use tokio::time::timeout;

// ── State held by Tauri::manage ─────────────────────────────────────────────

#[derive(Clone)]
pub struct SidecarState(Arc<Inner>);

struct Inner {
    port:   OnceCell<u16>,
    secret: OnceCell<String>,
    child:  Mutex<Option<Child>>,
}

impl SidecarState {
    pub fn new() -> Self {
        SidecarState(Arc::new(Inner {
            port:   OnceCell::new(),
            secret: OnceCell::new(),
            child:  Mutex::new(None),
        }))
    }

    pub async fn set_port(&self, port: u16) {
        let _ = self.0.port.set(port);
    }

    pub fn set_secret(&self, secret: String) {
        let _ = self.0.secret.set(secret);
    }

    pub fn get_secret(&self) -> Option<&str> {
        self.0.secret.get().map(|s| s.as_str())
    }

    pub async fn wait_for_port(&self, max: Duration) -> Option<u16> {
        if let Some(p) = self.0.port.get() {
            return Some(*p);
        }
        // Poll until set, up to `max`. The OnceCell doesn't expose a wait API,
        // so we busy-poll on a coarse interval.
        let deadline = tokio::time::Instant::now() + max;
        loop {
            if let Some(p) = self.0.port.get() {
                return Some(*p);
            }
            if tokio::time::Instant::now() >= deadline {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    pub async fn set_child(&self, child: Child) {
        let mut guard = self.0.child.lock().await;
        if let Some(mut old) = guard.take() {
            let _ = old.kill().await;
        }
        *guard = Some(child);
    }

    pub async fn shutdown(&self) {
        let mut guard = self.0.child.lock().await;
        if let Some(mut child) = guard.take() {
            tracing::info!("sidecar: killing child process tree");

            // On Windows, child.kill() only terminates the direct child (pnpm /
            // cmd.exe) and leaves grandchildren (tsx, node) running — keeping
            // SQLite locks open until they exit on their own.
            // taskkill /F /T kills the entire process tree.
            #[cfg(target_os = "windows")]
            if let Some(pid) = child.id() {
                let _ = tokio::process::Command::new("taskkill")
                    .args(["/F", "/T", "/PID", &pid.to_string()])
                    .output()
                    .await;
                tracing::info!(pid, "sidecar: taskkill sent to process tree");
            }

            let _ = child.kill().await;
            let _ = timeout(Duration::from_secs(3), child.wait()).await;
        }
    }
}

// ── Spawn ───────────────────────────────────────────────────────────────────

pub async fn spawn(state: SidecarState, _app: AppHandle) -> Result<(), String> {
    let pnpm = locate_pnpm()?;
    let workspace_root = locate_workspace_root()?;

    let secret = uuid::Uuid::new_v4().to_string();
    state.set_secret(secret.clone());

    tracing::info!(
        pnpm = %pnpm.display(),
        cwd  = %workspace_root.display(),
        "sidecar: launching ema-core"
    );

    let mut cmd = Command::new(&pnpm);
    cmd.args(["--filter", "@ema-agent/core", "dev"])
        .current_dir(&workspace_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .env("EMA_SHARED_SECRET", &secret);

    // On Windows, prevent a console window from popping up alongside the
    // sidecar process. CREATE_NO_WINDOW = 0x08000000.
    #[cfg(target_os = "windows")]
    {
        #[allow(unused_imports)]
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let mut child = cmd.spawn().map_err(|e| format!("spawn pnpm: {e}"))?;

    let stdout = child.stdout.take().ok_or("child stdout missing")?;
    let stderr = child.stderr.take().ok_or("child stderr missing")?;

    state.set_child(child).await;

    // Stdout reader: scrape for the port + forward lines to tracing
    let state_for_stdout = state.clone();
    tokio::spawn(async move {
        let re = Regex::new(r"listening on http://127\.0\.0\.1:(\d+)").unwrap();
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(caps) = re.captures(&line) {
                if let Ok(port) = caps[1].parse::<u16>() {
                    tracing::info!(port, "sidecar: port discovered");
                    state_for_stdout.set_port(port).await;
                }
            }
            tracing::debug!(target: "ema-core", "{line}");
        }
        tracing::warn!("sidecar: stdout closed");
    });

    // Stderr reader: forward to tracing as warn
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            tracing::warn!(target: "ema-core", "{line}");
        }
    });

    Ok(())
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn locate_pnpm() -> Result<PathBuf, String> {
    which::which("pnpm").map_err(|e| format!("pnpm not on PATH: {e}"))
}

/// Walk up from the Tauri crate to find the monorepo root (the dir with
/// pnpm-workspace.yaml). Falls back to the CARGO_MANIFEST_DIR's grandparent.
fn locate_workspace_root() -> Result<PathBuf, String> {
    let manifest = std::env::var("CARGO_MANIFEST_DIR")
        .map_err(|_| "CARGO_MANIFEST_DIR not set")?;
    let start = PathBuf::from(manifest);

    let mut current = start.as_path();
    while let Some(parent) = current.parent() {
        if parent.join("pnpm-workspace.yaml").exists() {
            return Ok(parent.to_path_buf());
        }
        current = parent;
    }
    // Fallback: <manifest>/../../  i.e. apps/desktop/src-tauri → repo root
    Ok(start.join("../..").canonicalize().map_err(|e| e.to_string())?)
}
