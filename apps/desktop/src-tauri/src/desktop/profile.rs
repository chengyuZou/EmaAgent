// 决议桌面宿主用于内置资源和启动日志的用户目录。
use std::path::PathBuf;

pub(crate) fn profile_root() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("EMA_PROFILE_DIR") {
        return Ok(PathBuf::from(path));
    }
    dirs::home_dir()
        .map(|home| home.join(".ema-agent"))
        .ok_or_else(|| "cannot resolve user home directory".to_string())
}
