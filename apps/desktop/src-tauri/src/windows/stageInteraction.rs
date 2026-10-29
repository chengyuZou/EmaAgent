use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, EventTarget, WebviewWindow};

const STAGE_PASSTHROUGH_EVENT: &str = "ema://pet-passthrough";
const STAGE_FOCUS_SETTLE_GRACE: Duration = Duration::from_millis(350);
static STAGE_FOCUSED_AT: Mutex<Option<Instant>> = Mutex::new(None);
// 控制区可临时接收点击, 但仍处于穿透模式, 不能恢复失焦自动最小化.
static STAGE_PASSTHROUGH_ENABLED: AtomicBool = AtomicBool::new(false);

pub fn begin_stage_focus_settling() {
    if let Ok(mut focused_at) = STAGE_FOCUSED_AT.lock() {
        *focused_at = Some(Instant::now());
    }
}

pub fn stage_passthrough_enabled() -> bool {
    STAGE_PASSTHROUGH_ENABLED.load(Ordering::SeqCst)
}

pub fn set_stage_passthrough(window: &WebviewWindow, enabled: bool) -> Result<(), String> {
    if window.label() != "stage" {
        return Err("click passthrough is only available for the pet window".into());
    }

    if !enabled {
        begin_stage_focus_settling();
    }
    let previous = STAGE_PASSTHROUGH_ENABLED.swap(enabled, Ordering::SeqCst);
    if let Err(error) = window.set_ignore_cursor_events(enabled) {
        STAGE_PASSTHROUGH_ENABLED.store(previous, Ordering::SeqCst);
        return Err(error.to_string());
    }
    window
        .emit_to(
            EventTarget::window("stage"),
            STAGE_PASSTHROUGH_EVENT,
            enabled,
        )
        .map_err(|error| error.to_string())
}

pub fn set_stage_passthrough_controls_hovered(
    window: &WebviewWindow,
    hovered: bool,
) -> Result<(), String> {
    if window.label() != "stage" {
        return Err("click passthrough is only available for the pet window".into());
    }
    // 托盘可能已关闭模式. 迟到的鼠标坐标更新不得重新开启原生穿透.
    window
        .set_ignore_cursor_events(stage_passthrough_enabled() && !hovered)
        .map_err(|error| error.to_string())
}

// 失焦最小化只用于未置顶且未穿透的舞台. 窗口刚恢复时先等焦点稳定.
pub fn minimize_unpinned_stage(window: &tauri::Window) -> bool {
    let focus_is_stable = STAGE_FOCUSED_AT
        .lock()
        .ok()
        .and_then(|focused_at| *focused_at)
        .map_or(true, |focused_at| {
            focused_at.elapsed() >= STAGE_FOCUS_SETTLE_GRACE
        });
    if focus_is_stable
        && !stage_passthrough_enabled()
        && matches!(window.is_always_on_top(), Ok(false))
    {
        if let Err(error) = window.minimize() {
            tracing::warn!(%error, "failed to minimize unpinned stage window");
        } else {
            return true;
        }
    }
    false
}
