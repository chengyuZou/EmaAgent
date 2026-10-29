#[path = "fileDialog.rs"]
pub mod file_dialog;

use file_dialog::{FileDialogState, SelectPathsOptions};
use serde::Serialize;

#[tauri::command]
pub async fn select_paths(
    window: tauri::Window,
    state: tauri::State<'_, FileDialogState>,
    options: SelectPathsOptions,
) -> Result<Vec<String>, String> {
    file_dialog::select_paths(window, &state, options).await
}

#[tauri::command]
pub fn open_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    // 用宿主侧 opener 打开路径本身, 自有 command 不经 WebView ACL.
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(&path, None::<&str>)
        .map_err(|error| {
            tracing::warn!(%path, %error, "open_path failed");
            error.to_string()
        })
}

#[tauri::command]
pub async fn read_local_image(path: String) -> Result<Vec<u8>, String> {
    // 原生选择和拖放只提供路径. WebView 读取字节后用于预览或上传,
    // 正式图片校验与保存仍由对应的 Server 导入接口处理.
    tokio::fs::read(path)
        .await
        .map_err(|error| error.to_string())
}

#[derive(Serialize)]
pub struct AttachmentPaths {
    files: Vec<String>,
    rejected: Vec<String>,
}

#[tauri::command]
pub async fn inspect_attachment_paths(paths: Vec<String>) -> AttachmentPaths {
    let mut result = AttachmentPaths {
        files: Vec::new(),
        rejected: Vec::new(),
    };
    for path in paths {
        match tokio::fs::metadata(&path).await {
            Ok(metadata) if metadata.is_file() => result.files.push(path),
            _ => result.rejected.push(path),
        }
    }
    result
}
