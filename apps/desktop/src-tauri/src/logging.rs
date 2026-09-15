// 每次桌面启动写一个日志文件,并把同一批记录继续输出到开发终端。
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::EnvFilter;

use crate::desktop::profile::profile_root;

const LOG_RETENTION: Duration = Duration::from_secs(14 * 24 * 60 * 60);

struct TerminalAndFile {
    file: Mutex<File>,
}

struct LogWriter<'a> {
    file: MutexGuard<'a, File>,
}

impl<'a> MakeWriter<'a> for TerminalAndFile {
    type Writer = LogWriter<'a>;

    fn make_writer(&'a self) -> Self::Writer {
        LogWriter {
            file: self
                .file
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        }
    }
}

impl Write for LogWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.file.write_all(bytes)?;
        let _ = io::stdout().write_all(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

pub(crate) fn init_logging() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,ema_desktop_lib=debug"));
    match open_launch_log() {
        Ok((path, file)) => {
            tracing_subscriber::fmt()
                .with_env_filter(filter)
                .with_target(false)
                .with_writer(TerminalAndFile {
                    file: Mutex::new(file),
                })
                .init();
            tracing::info!(path = %path.display(), pid = std::process::id(), "desktop launch log opened");
        }
        Err(error) => {
            tracing_subscriber::fmt()
                .with_env_filter(filter)
                .with_target(false)
                .init();
            tracing::error!(%error, "desktop launch log unavailable; terminal output remains active");
        }
    }
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
