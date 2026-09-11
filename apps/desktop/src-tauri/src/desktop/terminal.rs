// 持有用户直接操作的 PTY 会话，并把 Shell 输出送回对应的 Desktop 终端。
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
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

// kind 是 Node 探测给出的全小写 key,经 IPC 传入;Rust 只用它决定启动参数(如 PowerShell 补 -NoLogo)。
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalShellKind {
    PowerShell,
    Cmd,
    Bash,
    Zsh,
    Fish,
    Wsl,
    Sh,
}

// Shell 探测在 Node;Rust 只收"启动什么(path)+怎么启动(kind)"。
#[derive(Clone, Deserialize)]
pub struct TerminalShellSpec {
    pub kind: TerminalShellKind,
    pub path: String,
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
        shell: Option<TerminalShellSpec>,
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
        let mut command = shell_command(shell)?;
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

fn shell_command(shell: Option<TerminalShellSpec>) -> Result<CommandBuilder, String> {
    let spec = shell.filter(|spec| !spec.path.trim().is_empty());
    let (path, kind) = match spec {
        Some(spec) => {
            let path = PathBuf::from(&spec.path);
            if !path.is_file() {
                return Err(format!("选择的 Shell 不存在: {}", path.display()));
            }
            (path, Some(spec.kind))
        }
        // 仅在 Node 探测结果为空时走到这:平台默认 shell(cmd.exe 或 /bin/sh)无需补参数。
        None => (platform_shell_fallback(), None),
    };
    let mut command = CommandBuilder::new(path);
    if matches!(kind, Some(TerminalShellKind::PowerShell)) {
        command.arg("-NoLogo");
    }
    Ok(command)
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
