// 把 Desktop 终端的打开、输入、改尺寸和关闭操作交给 PTY 会话表。
use tauri::{ipc::Channel, State};

use crate::desktop::terminal::{
    detect_terminal_shells, DetectedTerminalShell, TerminalEvent, TerminalSessions,
};

#[tauri::command]
pub fn list_terminal_shells() -> Vec<DetectedTerminalShell> {
    detect_terminal_shells()
}

#[tauri::command]
pub fn open_terminal(
    terminals: State<'_, TerminalSessions>,
    terminal_id: String,
    session_id: String,
    cwd: Option<String>,
    shell_executable: Option<String>,
    columns: u16,
    rows: u16,
    on_event: Channel<TerminalEvent>,
) -> Result<(), String> {
    terminals.open(
        terminal_id,
        session_id,
        cwd,
        shell_executable,
        columns,
        rows,
        on_event,
    )
}

#[tauri::command]
pub fn write_terminal(
    terminals: State<'_, TerminalSessions>,
    terminal_id: String,
    data: String,
) -> Result<(), String> {
    terminals.write(&terminal_id, &data)
}

#[tauri::command]
pub fn resize_terminal(
    terminals: State<'_, TerminalSessions>,
    terminal_id: String,
    columns: u16,
    rows: u16,
) -> Result<(), String> {
    terminals.resize(&terminal_id, columns, rows)
}

#[tauri::command]
pub fn close_terminal(
    terminals: State<'_, TerminalSessions>,
    terminal_id: String,
) -> Result<(), String> {
    terminals.close(&terminal_id)
}

#[tauri::command]
pub fn close_session_terminals(
    terminals: State<'_, TerminalSessions>,
    session_id: String,
) -> Result<(), String> {
    terminals.close_session(&session_id)
}
