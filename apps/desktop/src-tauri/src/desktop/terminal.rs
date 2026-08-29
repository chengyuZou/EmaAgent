// 持有用户直接操作的 PTY 会话，并把 Shell 输出送回对应的 Desktop 终端。
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    thread,
};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;

#[derive(Clone)]
pub struct TerminalSessions {
    sessions: Arc<Mutex<HashMap<String, TerminalSession>>>,
}

struct TerminalSession {
    session_id: String,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TerminalShellKind {
    PowerShell,
    CommandPrompt,
    Bash,
    Zsh,
    Fish,
    Wsl,
    Sh,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedTerminalShell {
    pub label: String,
    pub kind: TerminalShellKind,
    pub executable_path: String,
}

#[derive(Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TerminalEvent {
    Output { data: Vec<u8> },
    Exit { exit_code: Option<u32> },
}

impl TerminalSessions {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn open(
        &self,
        terminal_id: String,
        session_id: String,
        cwd: Option<String>,
        shell_executable: Option<String>,
        columns: u16,
        rows: u16,
        on_event: Channel<TerminalEvent>,
    ) -> Result<(), String> {
        if self.sessions.lock().unwrap().contains_key(&terminal_id) {
            return Err("终端已经存在".into());
        }

        let working_dir = resolve_working_dir(cwd)?;
        let pty = native_pty_system()
            .openpty(PtySize {
                rows,
                cols: columns,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| error.to_string())?;
        let mut command = shell_command(shell_executable)?;
        command.cwd(working_dir);
        #[cfg(not(windows))]
        command.env("TERM", "xterm-256color");

        let child = pty
            .slave
            .spawn_command(command)
            .map_err(|error| error.to_string())?;
        let reader = pty
            .master
            .try_clone_reader()
            .map_err(|error| error.to_string())?;
        let writer = pty
            .master
            .take_writer()
            .map_err(|error| error.to_string())?;

        self.sessions.lock().unwrap().insert(
            terminal_id.clone(),
            TerminalSession {
                session_id,
                master: pty.master,
                writer,
                child,
            },
        );

        let sessions = self.clone();
        thread::spawn(move || read_output(sessions, terminal_id, reader, on_event));
        Ok(())
    }

    pub fn write(&self, terminal_id: &str, data: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(terminal_id)
            .ok_or_else(|| "终端不存在".to_string())?;
        session
            .writer
            .write_all(data.as_bytes())
            .and_then(|_| session.writer.flush())
            .map_err(|error| error.to_string())
    }

    pub fn resize(&self, terminal_id: &str, columns: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(terminal_id)
            .ok_or_else(|| "终端不存在".to_string())?;
        session
            .master
            .resize(PtySize {
                rows,
                cols: columns,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| error.to_string())
    }

    pub fn close(&self, terminal_id: &str) -> Result<(), String> {
        let session = self.sessions.lock().unwrap().remove(terminal_id);
        if let Some(mut session) = session {
            session.child.kill().map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub fn close_session(&self, session_id: &str) -> Result<(), String> {
        let terminal_ids = {
            let sessions = self.sessions.lock().unwrap();
            sessions
                .iter()
                .filter_map(|(terminal_id, session)| {
                    (session.session_id == session_id).then(|| terminal_id.clone())
                })
                .collect::<Vec<_>>()
        };
        let mut first_error = None;
        for terminal_id in terminal_ids {
            if let Err(error) = self.close(&terminal_id) {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    fn finish(&self, terminal_id: &str) -> Option<u32> {
        let mut session = self.sessions.lock().unwrap().remove(terminal_id)?;
        // 走到这里说明 Channel 已断开（WebView 刷新/崩溃），终端没有观众：
        // 先尝试收割，仍在运行则直接终止，不让 shell 成为孤儿。
        match session.child.try_wait() {
            Ok(Some(status)) => Some(status.exit_code()),
            _ => {
                let _ = session.child.kill();
                session.child.wait().ok().map(|status| status.exit_code())
            }
        }
    }

    /// 应用退出时回收全部 PTY 会话；Desktop 的进程树只管 Server/Narrative。
    pub fn close_all(&self) {
        let sessions = std::mem::take(&mut *self.sessions.lock().unwrap());
        for (_, mut session) in sessions {
            let _ = session.child.kill();
        }
    }
}

pub fn detect_terminal_shells() -> Vec<DetectedTerminalShell> {
    let mut paths = discover_shell_paths();
    paths.sort_by_key(|path| shell_priority(shell_kind(path)));
    paths
        .into_iter()
        .map(|path| DetectedTerminalShell {
            label: shell_label(&path),
            kind: shell_kind(&path),
            executable_path: path.to_string_lossy().into_owned(),
        })
        .collect()
}

fn read_output(
    sessions: TerminalSessions,
    terminal_id: String,
    mut reader: Box<dyn Read + Send>,
    on_event: Channel<TerminalEvent>,
) {
    let mut buffer = vec![0_u8; 16 * 1024];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                if on_event
                    .send(TerminalEvent::Output {
                        data: buffer[..count].to_vec(),
                    })
                    .is_err()
                {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let exit_code = sessions.finish(&terminal_id);
    let _ = on_event.send(TerminalEvent::Exit { exit_code });
}

fn resolve_working_dir(cwd: Option<String>) -> Result<PathBuf, String> {
    let path = cwd
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .ok_or_else(|| "无法确定终端工作目录".to_string())?;
    if !Path::new(&path).is_dir() {
        return Err(format!("终端工作目录不存在: {}", path.display()));
    }
    Ok(path)
}

fn shell_command(shell_executable: Option<String>) -> Result<CommandBuilder, String> {
    let path = match shell_executable.filter(|value| !value.trim().is_empty()) {
        Some(value) => {
            let path = PathBuf::from(value);
            if !path.is_file() {
                return Err(format!("选择的 Shell 不存在: {}", path.display()));
            }
            path
        }
        None => default_shell_path(),
    };
    let kind = shell_kind(&path);
    let mut command = CommandBuilder::new(path);
    if matches!(kind, TerminalShellKind::PowerShell) {
        command.arg("-NoLogo");
    }
    Ok(command)
}

fn default_shell_path() -> PathBuf {
    detect_terminal_shells()
        .into_iter()
        .next()
        .map(|shell| PathBuf::from(shell.executable_path))
        .unwrap_or_else(platform_shell_fallback)
}

#[cfg(windows)]
fn discover_shell_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for name in [
        "pwsh.exe",
        "powershell.exe",
        "cmd.exe",
        "bash.exe",
        "wsl.exe",
    ] {
        if let Ok(output) = Command::new("where.exe").arg(name).output() {
            if output.status.success() {
                paths.extend(
                    String::from_utf8_lossy(&output.stdout)
                        .lines()
                        .map(str::trim)
                        .filter(|line| !line.is_empty())
                        .map(PathBuf::from),
                );
            }
        }
    }
    if let Ok(comspec) = std::env::var("COMSPEC") {
        paths.push(PathBuf::from(comspec));
    }
    distinct_existing_paths(paths)
}

#[cfg(not(windows))]
fn discover_shell_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(shell) = std::env::var("SHELL") {
        paths.push(PathBuf::from(shell));
    }
    for name in ["bash", "zsh", "fish", "sh"] {
        if let Ok(output) = Command::new("which").arg("-a").arg(name).output() {
            if output.status.success() {
                paths.extend(
                    String::from_utf8_lossy(&output.stdout)
                        .lines()
                        .map(str::trim)
                        .filter(|line| !line.is_empty())
                        .map(PathBuf::from),
                );
            }
        }
    }
    distinct_existing_paths(paths)
}

fn distinct_existing_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = std::collections::HashSet::new();
    paths
        .into_iter()
        .filter(|path| path.is_file())
        .filter(|path| {
            let key = path.to_string_lossy().to_ascii_lowercase();
            seen.insert(key)
        })
        .collect()
}

fn shell_kind(path: &Path) -> TerminalShellKind {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match name.as_str() {
        "pwsh" | "pwsh.exe" | "powershell" | "powershell.exe" => TerminalShellKind::PowerShell,
        "cmd" | "cmd.exe" => TerminalShellKind::CommandPrompt,
        "bash" | "bash.exe" => TerminalShellKind::Bash,
        "zsh" => TerminalShellKind::Zsh,
        "fish" => TerminalShellKind::Fish,
        "wsl" | "wsl.exe" => TerminalShellKind::Wsl,
        _ => TerminalShellKind::Sh,
    }
}

fn shell_label(path: &Path) -> String {
    let lower_path = path.to_string_lossy().to_ascii_lowercase();
    match shell_kind(path) {
        TerminalShellKind::PowerShell
            if lower_path.ends_with("pwsh.exe") || lower_path.ends_with("/pwsh") =>
        {
            "PowerShell 7".into()
        }
        TerminalShellKind::PowerShell => "Windows PowerShell".into(),
        TerminalShellKind::CommandPrompt => "Command Prompt".into(),
        TerminalShellKind::Bash if lower_path.contains("git") => "Git Bash".into(),
        TerminalShellKind::Bash => "Bash".into(),
        TerminalShellKind::Zsh => "Zsh".into(),
        TerminalShellKind::Fish => "Fish".into(),
        TerminalShellKind::Wsl => "WSL".into(),
        TerminalShellKind::Sh => "Shell".into(),
    }
}

fn shell_priority(kind: TerminalShellKind) -> u8 {
    match kind {
        TerminalShellKind::PowerShell => 0,
        TerminalShellKind::Bash => 1,
        TerminalShellKind::Zsh => 2,
        TerminalShellKind::Fish => 3,
        TerminalShellKind::Wsl => 4,
        TerminalShellKind::CommandPrompt => 5,
        TerminalShellKind::Sh => 6,
    }
}

#[cfg(windows)]
fn platform_shell_fallback() -> PathBuf {
    std::env::var("COMSPEC")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("cmd.exe"))
}

#[cfg(not(windows))]
fn platform_shell_fallback() -> PathBuf {
    PathBuf::from("/bin/sh")
}
