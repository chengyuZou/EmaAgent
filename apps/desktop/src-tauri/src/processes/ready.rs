// 等待子进程在实际监听后通过 stdout 报告端口。
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::process::Child;
use tokio::sync::{mpsc, Mutex};

pub async fn wait_for_ready(
    label: &str,
    max_wait: Duration,
    shutdown_requested: &AtomicBool,
    child: &Mutex<Option<Child>>,
    ready: &mut mpsc::UnboundedReceiver<u16>,
) -> Result<u16, String> {
    let started = tokio::time::Instant::now();
    let deadline = started + max_wait;
    loop {
        if shutdown_requested.load(Ordering::Acquire) {
            return Err(format!("{label} startup cancelled"));
        }

        if let Some(process) = child.lock().await.as_mut() {
            match process.try_wait() {
                Ok(Some(status)) => {
                    return Err(format!(
                        "{label} exited before readiness ({status}) after {:.3} s",
                        started.elapsed().as_secs_f64(),
                    ));
                }
                Ok(None) => {}
                Err(error) => return Err(format!("poll {label} before readiness: {error}")),
            }
        }

        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "{label} readiness timed out after {:.3} s",
                started.elapsed().as_secs_f64(),
            ));
        }
        tokio::select! {
            Some(port) = ready.recv() => return Ok(port),
            _ = tokio::time::sleep(Duration::from_millis(50)) => {}
        }
    }
}
