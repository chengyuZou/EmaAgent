use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use serde::Deserialize;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, FilePath};

#[derive(Default)]
pub struct FileDialogState {
    open: Arc<AtomicBool>,
}

struct OpenDialog(Arc<AtomicBool>);

impl Drop for OpenDialog {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl FileDialogState {
    fn acquire(&self) -> Result<OpenDialog, String> {
        self.open
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "已有文件选择窗口, 请先完成或取消该选择".to_string())?;
        Ok(OpenDialog(Arc::clone(&self.open)))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectPathsOptions {
    title: Option<String>,
    #[serde(default)]
    directory: bool,
    #[serde(default)]
    multiple: bool,
    #[serde(default)]
    filters: Vec<FileFilter>,
}

#[derive(Deserialize)]
pub struct FileFilter {
    name: String,
    extensions: Vec<String>,
}

pub async fn select_paths(
    window: tauri::Window,
    state: &FileDialogState,
    options: SelectPathsOptions,
) -> Result<Vec<String>, String> {
    if window.label() != "main" {
        return Err("请从主窗口选择文件".to_string());
    }
    let guard = state.acquire()?;
    let mut dialog = window.app_handle().dialog().file();
    // Windows 的模态选择框会禁用 owner. 此入口不绑定主窗口, 旧插件入口仍保留原行为.
    #[cfg(not(windows))]
    {
        dialog = dialog.set_parent(&window);
    }
    if let Some(title) = options.title {
        dialog = dialog.set_title(title);
    }
    for filter in options.filters {
        let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
        dialog = dialog.add_filter(filter.name, &extensions);
    }

    let (sender, receiver) = tokio::sync::oneshot::channel();
    let complete = move |paths: Option<Vec<FilePath>>| {
        // 即使前端已经离开或 IPC 等待被取消, 也要等原生窗口关闭后才允许再次打开.
        drop(guard);
        let _ = sender.send(paths);
    };
    match (options.directory, options.multiple) {
        (true, true) => dialog.pick_folders(complete),
        (true, false) => dialog.pick_folder(move |path| complete(path.map(|value| vec![value]))),
        (false, true) => dialog.pick_files(complete),
        (false, false) => dialog.pick_file(move |path| complete(path.map(|value| vec![value]))),
    }

    receiver
        .await
        .map_err(|_| "文件选择未返回结果".to_string())?
        .unwrap_or_default()
        .into_iter()
        .map(|path| {
            path.into_path()
                .map(|path| path.to_string_lossy().into_owned())
                .map_err(|error| error.to_string())
        })
        .collect()
}

#[cfg(test)]
#[path = "../../tests/fileDialog.rs"]
mod tests;
