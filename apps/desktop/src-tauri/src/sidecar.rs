// ── Sidecar + Bridge lifecycle ──────────────────────────────────────────────
//
// Spawns two child processes:
//   1. `pnpm --filter @ema-agent/core dev`  — the Node sidecar (business logic)
//   2. `uv run ema-bridge`                   — the Python FastAPI bridge (narrative)
//
// Both are assigned to a Windows Job Object with KILL_ON_JOB_CLOSE: when the
// Rust process exits (any path — clean quit, crash, Task Manager kill), the OS
// automatically kills the entire Job, so no orphan sidecar/bridge processes
// survive to hold the SQLite lockfile (bug 4 fix).
//
// Wired in lib.rs (F-048 订正:窗口 X 是 prevent_close + hide,不触发 shutdown):
//   - setup()                 → tauri::async_runtime::spawn(spawn(...))
//   - WindowEvent::CloseRequested → api.prevent_close() + window.hide()  (不 shutdown)
//   - 托盘菜单 "quit" / quit_app 命令 → state.shutdown().await + app.exit(0)
//   - RunEvent::Exit           → state.shutdown().await  (最后防线清理)

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
    // sidecar + bridge 两个子进程；shutdown 时都杀
    sidecar: Mutex<Option<Child>>,
    bridge:  Mutex<Option<Child>>,
}

impl SidecarState {
    pub fn new() -> Self {
        SidecarState(Arc::new(Inner {
            port:    OnceCell::new(),
            secret:  OnceCell::new(),
            sidecar: Mutex::new(None),
            bridge:  Mutex::new(None),
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

    pub async fn set_sidecar(&self, child: Child) {
        let mut guard = self.0.sidecar.lock().await;
        if let Some(mut old) = guard.take() {
            let _ = old.kill().await;
        }
        *guard = Some(child);
    }

    pub async fn set_bridge(&self, child: Child) {
        let mut guard = self.0.bridge.lock().await;
        if let Some(mut old) = guard.take() {
            let _ = old.kill().await;
        }
        *guard = Some(child);
    }

    pub async fn shutdown(&self) {
        // 同时杀 sidecar + bridge。每个都走 taskkill /F /T（兜底）+ child.kill。
        // Job Object（assign_to_job 设的）会在 Rust 进程退出时兜底清理整棵树。
        self.kill_child(&self.0.sidecar, "sidecar").await;
        self.kill_child(&self.0.bridge,  "bridge").await;
        // sidecar 被强杀没机会跑 release() 清 lockfile -> 主动删文件,防残留
        // (bug 4:lockfile 残留指向已死 pid,虽然下次启动 isHolderDead 能重抢,但文件残留让用户困惑)
        self.remove_lockfile();
    }

    /// 删 sidecar 的 lockfile.json。跟 Node 层 profileDir 对齐:
    /// EMA_PROFILE_DIR env 优先,否则 ~/.ema-agent。跨平台 std::fs::remove_file。
    fn remove_lockfile(&self) {
        let dir = std::env::var("EMA_PROFILE_DIR")
            .or_else(|_| {
                std::env::var("USERPROFILE")
                    .or_else(|_| std::env::var("HOME"))
                    .map(|h| format!("{}/.ema-agent", h))
            })
            .unwrap_or_else(|_| "~/.ema-agent".to_string());
        let fp = std::path::PathBuf::from(dir).join("lockfile.json");
        match std::fs::remove_file(&fp) {
            Ok(()) => tracing::info!(path = %fp.display(), "lockfile removed"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // 没有 lockfile 正常(sidecar 没起来就退出),不算错
            }
            Err(e) => tracing::warn!(path = %fp.display(), "lockfile remove failed: {e}"),
        }
    }

    async fn kill_child(&self, slot: &Mutex<Option<Child>>, label: &str) {
        let mut guard = slot.lock().await;
        let Some(mut child) = guard.take() else { return };
        tracing::info!(label, "killing child process tree");

        #[cfg(target_os = "windows")]
        if let Some(pid) = child.id() {
            let result = tokio::process::Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .output()
                .await;
            if let Err(e) = result {
                tracing::warn!(label, pid, "taskkill failed: {e} — relying on Job Object fallback");
            } else {
                tracing::info!(label, pid, "taskkill sent to process tree");
            }
        }

        let _ = child.kill().await;
        let _ = timeout(Duration::from_secs(3), child.wait()).await;
    }
}

// ── Windows Job Object ──────────────────────────────────────────────────────
//
// 把子进程分配到 Job Object（KILL_ON_JOB_CLOSE）。Rust 进程退出时（无论何种原因），
// OS 自动 kill 整个 Job 内所有进程。这是 Windows 上唯一可靠的进程树清理机制，
// 不依赖 taskkill /T 的进程树完整性（pnpm → tsx → node 多层树容易断）。
//
// win32job 的 assign_process 接进程 handle（isize），不是 pid，所以要先 OpenProcess。
// Job handle 用 forget 活到进程退出——退出时 handle 关闭，OS 触发清理。

#[cfg(target_os = "windows")]
fn assign_to_job(pid: u32) -> Result<(), String> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    // PROCESS_SET_QUOTA + PROCESS_TERMINATE 是 AssignProcessToJobObject 所需权限
    let handle = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
    if handle.is_null() {
        return Err(format!("OpenProcess(pid={pid}) failed"));
    }

    let result = (|| -> Result<(), String> {
        use win32job::{ExtendedLimitInfo, Job};
        let mut info = ExtendedLimitInfo::new();
        info.limit_kill_on_job_close();
        let job = Job::create_with_limit_info(&info).map_err(|e| format!("create job: {e}"))?;
        // win32job assign_process 接 isize，HANDLE 转 isize
        job.assign_process(handle as isize).map_err(|e| format!("assign process to job: {e}"))?;
        // leak job handle — 活到进程退出，退出时 OS 自动 kill Job 内所有进程
        std::mem::forget(job);
        tracing::info!(pid, "assigned child to Job Object (KILL_ON_JOB_CLOSE)");
        Ok(())
    })();

    // 子进程 handle 用完即关（Job 已持有引用）
    unsafe { CloseHandle(handle) };
    result
}

#[cfg(not(target_os = "windows"))]
fn assign_to_job(_pid: u32) -> Result<(), String> {
    Ok(()) // 非 Windows 无 Job Object，靠 child.kill + 信号
}

// ── Spawn ───────────────────────────────────────────────────────────────────

pub async fn spawn(state: SidecarState, _app: AppHandle) -> Result<(), String> {
    let pnpm = locate_pnpm()?;
    let workspace_root = locate_workspace_root()?;
    let bridge_dir = workspace_root.join("apps/bridge");

    let secret = crate::credential_key::generate_ephemeral_secret();
    let credential_master_key = crate::credential_key::load_or_create_master_key()?;
    state.set_secret(secret.clone());

    // ── 1. sidecar (Node) ──
    tracing::info!(
        pnpm = %pnpm.display(),
        cwd  = %workspace_root.display(),
        "sidecar: launching ema-core"
    );
    let mut sidecar_cmd = Command::new(&pnpm);
    sidecar_cmd
        .args(["--filter", "@ema-agent/core", "dev"])
        .current_dir(&workspace_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .env("EMA_SHARED_SECRET", &secret)
        .env("EMA_CREDENTIAL_MASTER_KEY", &credential_master_key);
    apply_windows_flags(&mut sidecar_cmd);
    let mut sidecar_child = sidecar_cmd.spawn().map_err(|e| format!("spawn pnpm: {e}"))?;
    if let Some(pid) = sidecar_child.id() {
        if let Err(e) = assign_to_job(pid) {
            tracing::warn!("sidecar: assign_to_job failed ({e}) — 依赖 taskkill 兜底");
        }
    }
    pipe_stdout(sidecar_child.stdout.take(), state.clone(), "sidecar");
    pipe_stderr(sidecar_child.stderr.take(), "sidecar");
    state.set_sidecar(sidecar_child).await;

    // ── 2. bridge (Python) ──
    // fire-and-forget：失败只 warn 不阻断（CLAUDE.md：bridge 未启动 → 仅 narrative 降级，主链路不死）
    match locate_uv() {
        Ok(uv) => {
            tracing::info!(uv = %uv.display(), cwd = %bridge_dir.display(), "bridge: launching ema-bridge");
            let mut bridge_cmd = Command::new(&uv);
            bridge_cmd
                .args(["run", "ema-bridge"])
                .current_dir(&bridge_dir)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .stdin(Stdio::null())
                .env("EMA_SHARED_SECRET", &secret)
                // bridge 扫端口 7421-7430，写 {EMA_DATA_DIR}/bridge.port 让 core 发现
                .env("EMA_DATA_DIR", std::env::var("EMA_DATA_DIR").unwrap_or_else(|_| dirs_home()));
            apply_windows_flags(&mut bridge_cmd);
            match bridge_cmd.spawn() {
                Ok(mut bridge_child) => {
                    if let Some(pid) = bridge_child.id() {
                        if let Err(e) = assign_to_job(pid) {
                            tracing::warn!("bridge: assign_to_job failed ({e}) — 依赖 taskkill 兜底");
                        }
                    }
                    pipe_stdout(bridge_child.stdout.take(), state.clone(), "bridge");
                    pipe_stderr(bridge_child.stderr.take(), "bridge");
                    state.set_bridge(bridge_child).await;
                }
                Err(e) => {
                    tracing::warn!("bridge: spawn failed ({e}) — narrative 模式将降级为 chat");
                }
            }
        }
        Err(e) => {
            tracing::warn!("bridge: uv not found ({e}) — narrative 模式将降级为 chat。装 uv 后可启用");
        }
    }

    Ok(())
}

// ── stdout/stderr piping ────────────────────────────────────────────────────

fn pipe_stdout(stdout: Option<tokio::process::ChildStdout>, state: SidecarState, label: &'static str) {
    let Some(stdout) = stdout else { return };
    tokio::spawn(async move {
        let re = Regex::new(r"listening on http://127\.0\.0\.1:(\d+)").unwrap();
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            // sidecar 的端口行才抓；bridge 端口走 bridge.port 文件，core 自己发现
            if label == "sidecar" {
                if let Some(caps) = re.captures(&line) {
                    if let Ok(port) = caps[1].parse::<u16>() {
                        tracing::info!(port, "sidecar: port discovered");
                        state.set_port(port).await;
                    }
                }
            }
            tracing::debug!("[{label}] {line}");
        }
        tracing::warn!("[{label}] stdout closed");
    });
}

fn pipe_stderr(stderr: Option<tokio::process::ChildStderr>, label: &'static str) {
    let Some(stderr) = stderr else { return };
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            tracing::warn!("[{label}] {line}");
        }
    });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn apply_windows_flags(cmd: &mut Command) {
    // CREATE_NO_WINDOW = 0x08000000 — 防止 sidecar/bridge 弹出控制台窗口
    #[allow(unused_imports)]
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000);
}

#[cfg(not(target_os = "windows"))]
fn apply_windows_flags(_cmd: &mut Command) {}

fn locate_pnpm() -> Result<PathBuf, String> {
    which::which("pnpm").map_err(|e| format!("pnpm not on PATH: {e}"))
}

fn locate_uv() -> Result<PathBuf, String> {
    which::which("uv").map_err(|e| format!("uv not on PATH: {e}"))
}

/// ~/.ema-agent 作为 EMA_DATA_DIR 默认值（与 core 的 lockfile.ts 保持一致）
fn dirs_home() -> String {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(|h| format!("{}/.ema-agent", h))
        .unwrap_or_else(|_| "~/.ema-agent".to_string())
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
    Ok(start.join("../..").canonicalize().map_err(|e| e.to_string())?)
}
