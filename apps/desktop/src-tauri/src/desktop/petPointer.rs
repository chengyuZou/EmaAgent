// 在原生主线程读取系统鼠标, 向桌宠推送窗口内逻辑坐标.
use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, EventTarget, WebviewWindow};

use super::windows::set_main_passthrough;

const PET_POINTER_EVENT: &str = "ema://pet-pointer";
const POINTER_INTERVAL: Duration = Duration::from_nanos(1_000_000_000 / 60);

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum PetPointerEvent {
    Position {
        client_x: f64,
        client_y: f64,
        inside: bool,
    },
    Error {
        message: String,
    },
}

#[derive(Default)]
pub struct PetPointerTracking {
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl PetPointerTracking {
    pub fn start(&self, window: WebviewWindow) -> Result<(), String> {
        if window.label() != "main" {
            return Err("system pointer tracking is only available for the pet window".into());
        }
        // 开始订阅前确认系统坐标可读, 失败时前端不能开放穿透按钮.
        window.cursor_position().map_err(|error| error.to_string())?;
        let mut task = self.task.lock().map_err(|error| error.to_string())?;
        if let Some(previous) = task.take() {
            previous.abort();
        }
        *task = Some(tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(POINTER_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                let (completed, completion) = tokio::sync::oneshot::channel();
                let sampled_window = window.clone();
                if let Err(error) = window.run_on_main_thread(move || {
                    // HMR 重新订阅会取消旧任务, 不让已排队的旧采样再影响新订阅.
                    if completed.is_closed() {
                        return;
                    }
                    let result = sample_and_emit(&sampled_window);
                    if let Err(error) = &result {
                        tracing::error!(%error, "pet system pointer tracking failed");
                        if let Err(restore_error) = set_main_passthrough(&sampled_window, false) {
                            tracing::error!(%restore_error, "failed to restore pet pointer interaction");
                        }
                        let _ = sampled_window.emit_to(
                            EventTarget::window("main"),
                            PET_POINTER_EVENT,
                            PetPointerEvent::Error { message: error.clone() },
                        );
                    }
                    let _ = completed.send(result);
                }) {
                    tracing::error!(%error, "failed to schedule pet pointer sample");
                    break;
                }
                // 每次采样结束后才允许下一次, 主线程忙时不会堆积采样任务.
                if !matches!(completion.await, Ok(Ok(()))) {
                    break;
                }
            }
        }));
        Ok(())
    }

    pub fn stop(&self) {
        if let Ok(mut task) = self.task.lock() {
            if let Some(task) = task.take() {
                task.abort();
            }
        }
    }
}

fn sample_and_emit(window: &WebviewWindow) -> Result<(), String> {
    if !window.is_visible().map_err(|error| error.to_string())?
        || window.is_minimized().map_err(|error| error.to_string())?
    {
        return Ok(());
    }
    let cursor = window.cursor_position().map_err(|error| error.to_string())?;
    let position = window.inner_position().map_err(|error| error.to_string())?;
    let size = window.inner_size().map_err(|error| error.to_string())?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let relative_x = cursor.x - f64::from(position.x);
    let relative_y = cursor.y - f64::from(position.y);
    let pointer = PetPointerEvent::Position {
        client_x: relative_x / scale,
        client_y: relative_y / scale,
        inside: relative_x >= 0.0 && relative_x < f64::from(size.width)
            && relative_y >= 0.0 && relative_y < f64::from(size.height),
    };
    window
        .emit_to(EventTarget::window("main"), PET_POINTER_EVENT, pointer)
        .map_err(|error| error.to_string())
}
