// 汇总本地文件能力句柄、原生选择器、拖拽授权和安全打开入口。
mod capability;
mod commands;
mod types;

pub use capability::FileAccessFacade;
pub use commands::{
    install_authorized_drop_handler, open_authorized_file, pick_authorized_directory,
    pick_authorized_files,
};
