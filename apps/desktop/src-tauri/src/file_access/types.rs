// 定义 Rust Host 与 WebView 之间不暴露绝对路径的文件授权结构。
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizedFile {
    pub file_handle: String,
    pub name: String,
    pub size: u64,
    pub mtime: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct DropPosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct AuthorizedFileDrop {
    pub files: Vec<AuthorizedFile>,
    pub position: DropPosition,
}
