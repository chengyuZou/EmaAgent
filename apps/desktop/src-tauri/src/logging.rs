use std::fs::{self, File, OpenOptions};
use std::io::{self, IsTerminal};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tracing_subscriber::prelude::*;
use tracing_subscriber::EnvFilter;

use crate::profile_path::profile_root;

const LOG_RETENTION: Duration = Duration::from_secs(14 * 24 * 60 * 60);

pub(crate) fn init_logging() {
    let terminal_ansi = io::stdout().is_terminal()
        && std::env::var("NO_COLOR").map_or(true, |value| value.is_empty());
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,ema_desktop_lib=debug"));
    match open_launch_log() {
        Ok((path, file)) => {
            launch_subscriber(file, filter, terminal_ansi).init();
            tracing::info!(path = %path.display(), pid = std::process::id(), "desktop launch log opened");
        }
        Err(error) => {
            tracing_subscriber::fmt()
                .with_env_filter(filter)
                .with_target(false)
                .with_ansi(terminal_ansi)
                .init();
            tracing::error!(%error, "desktop launch log unavailable; terminal output remains active");
        }
    }
}

fn launch_subscriber(
    file: File,
    filter: EnvFilter,
    terminal_ansi: bool,
) -> impl tracing::Subscriber + Send + Sync {
    tracing_subscriber::registry()
        .with(filter)
        // 同类型格式层会共用 span 字段缓存, 先生成纯文本, 避免终端颜色进入文件的 span 字段.
        .with(
            tracing_subscriber::fmt::layer()
                .with_target(false)
                .with_ansi(false)
                .with_writer(Mutex::new(file)),
        )
        .with(
            tracing_subscriber::fmt::layer()
                .with_target(false)
                .with_ansi(terminal_ansi)
                .with_writer(io::stdout),
        )
}

fn open_launch_log() -> Result<(PathBuf, File), String> {
    let directory = profile_root()?.join("logs");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("create log directory {}: {error}", directory.display()))?;
    remove_expired_logs(&directory);
    let started_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("read system time: {error}"))?
        .as_secs();
    let path = directory.join(format!("ema-{started_at}-{}.log", std::process::id()));
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| format!("create launch log {}: {error}", path.display()))?;
    Ok((path, file))
}

fn remove_expired_logs(directory: &Path) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("ema-") || !name.ends_with(".log") {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if modified
            .elapsed()
            .is_ok_and(|elapsed| elapsed > LOG_RETENTION)
        {
            let _ = fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_log_preserves_text_without_terminal_escape_codes() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "ema-log-format-test-{}-{unique}.log",
            std::process::id()
        ));
        let file = File::create(&path).expect("create test log");
        tracing::subscriber::with_default(
            launch_subscriber(file, EnvFilter::new("info"), true),
            || {
                tracing::info_span!("startup", label = "server").in_scope(|| {
                    tracing::info!(port = 12345, "启动日志测试");
                });
            },
        );
        let text = fs::read_to_string(&path).expect("read test log");
        fs::remove_file(&path).expect("remove test log");

        assert!(text.contains("启动日志测试"));
        assert!(
            !text.contains('\u{1b}'),
            "file contains ANSI escapes: {text:?}"
        );
        assert!(text.contains("label=\"server\""));
    }

    #[test]
    fn removes_only_expired_launch_logs() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "ema-log-retention-test-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir(&directory).expect("create test log directory");

        let expired = directory.join("ema-old.log");
        let current = directory.join("ema-current.log");
        let unrelated = directory.join("unrelated.log");
        File::create(&expired).expect("create expired log");
        File::create(&current).expect("create current log");
        File::create(&unrelated).expect("create unrelated file");
        let old_time = SystemTime::now() - LOG_RETENTION - Duration::from_secs(1);
        File::options()
            .write(true)
            .open(&expired)
            .expect("open expired log")
            .set_modified(old_time)
            .expect("mark expired log old");
        File::options()
            .write(true)
            .open(&unrelated)
            .expect("open unrelated file")
            .set_modified(old_time)
            .expect("mark unrelated file old");

        remove_expired_logs(&directory);

        assert!(!expired.exists());
        assert!(current.exists());
        assert!(unrelated.exists());
        fs::remove_dir_all(&directory).expect("remove test log directory");
    }
}
