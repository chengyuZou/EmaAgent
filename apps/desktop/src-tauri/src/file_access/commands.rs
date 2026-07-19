// 将原生文件选择和拖拽转换为能力句柄，并只允许打开已验证的句柄。
use std::path::PathBuf;

use tauri::{DragDropEvent, Emitter, WebviewEvent, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use super::capability::FileAccessFacade;
use super::types::{AuthorizedFile, AuthorizedFileDrop, DropPosition};

const AUTHORIZED_DROP_EVENT: &str = "ema://authorized-file-drop";

#[tauri::command]
pub async fn pick_authorized_files(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, FileAccessFacade>,
) -> Result<Vec<AuthorizedFile>, String> {
    require_chat_window(&window)?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_files(move |files| {
        let _ = sender.send(files);
    });
    let files = receiver
        .await
        .map_err(|_| "原生文件选择器提前关闭".to_string())?
        .unwrap_or_default();
    let paths = files
        .into_iter()
        .filter_map(|file| file.into_path().ok())
        .collect::<Vec<PathBuf>>();
    Ok(state.authorize_paths(paths))
}

#[tauri::command]
pub async fn open_authorized_file(
    file_handle: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, FileAccessFacade>,
) -> Result<(), String> {
    require_chat_window(&window)?;
    let path = state.resolve(&file_handle)?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| format!("附件已不存在或不可访问: {error}"))?;
    if !metadata.is_file() {
        return Err("文件能力指向的不是普通文件".to_string());
    }
    tauri_plugin_opener::open_path(path, None::<&str>)
        .map_err(|error| format!("调用系统程序打开附件失败: {error}"))
}

fn require_chat_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "chat" {
        return Err("本地附件能力只允许聊天窗口使用".to_string());
    }
    Ok(())
}

pub fn install_authorized_drop_handler(window: &WebviewWindow, facade: FileAccessFacade) {
    let emitter = window.clone();
    window.on_webview_event(move |event| {
        let WebviewEvent::DragDrop(DragDropEvent::Drop { paths, position }) = event else {
            return;
        };
        let files = facade.authorize_paths(paths.clone());
        if files.is_empty() {
            return;
        }
        let payload = AuthorizedFileDrop {
            files,
            position: DropPosition {
                x: position.x,
                y: position.y,
            },
        };
        if let Err(error) = emitter.emit(AUTHORIZED_DROP_EVENT, payload) {
            tracing::warn!(%error, "emit authorized file drop failed");
        }
    });
}
