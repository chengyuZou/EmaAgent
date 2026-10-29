use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::System::Threading::{
    AttachThreadInput, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::*;

use crate::types::ComputerWindow;

pub fn handle(id: &str) -> Result<HWND, String> {
    let value = id
        .parse::<isize>()
        .map_err(|_| "Invalid window id.".to_owned())?;
    let hwnd = HWND(value as *mut _);
    if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
        return Err("The target window no longer exists.".to_owned());
    }
    Ok(hwnd)
}

pub fn describe(hwnd: HWND) -> Result<ComputerWindow, String> {
    unsafe {
        let mut rect = RECT::default();
        GetWindowRect(hwnd, &mut rect).map_err(|error| error.to_string())?;
        // 截图不含窗口外的透明调整边框. 坐标也按可见边框计算, 否则点击会有偏移.
        let _ = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut _ as *mut _,
            std::mem::size_of::<RECT>() as u32,
        );
        let length = GetWindowTextLengthW(hwnd).max(0) as usize;
        let mut title = vec![0u16; length + 1];
        let length = GetWindowTextW(hwnd, &mut title).max(0) as usize;
        let mut process_id = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
        let mut app = format!("pid:{process_id}");
        if let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) {
            let mut buffer = vec![0u16; 32768];
            let mut length = buffer.len() as u32;
            if QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_WIN32,
                PWSTR(buffer.as_mut_ptr()),
                &mut length,
            )
            .is_ok()
            {
                app = String::from_utf16_lossy(&buffer[..length as usize]);
            }
            let _ = CloseHandle(process);
        }
        Ok(ComputerWindow {
            id: (hwnd.0 as isize).to_string(),
            title: String::from_utf16_lossy(&title[..length]),
            app,
            x: rect.left,
            y: rect.top,
            width: rect.right - rect.left,
            height: rect.bottom - rect.top,
        })
    }
}

pub fn list() -> Result<Vec<ComputerWindow>, String> {
    let mut result = Vec::new();
    unsafe extern "system" fn collect(hwnd: HWND, data: LPARAM) -> BOOL {
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() || GetWindowTextLengthW(hwnd) == 0 {
                return true.into();
            }
            let mut class = [0u16; 128];
            let length = GetClassNameW(hwnd, &mut class).max(0) as usize;
            if String::from_utf16_lossy(&class[..length]) == "EmaComputerUseOverlay" {
                return true.into();
            }
            if let Ok(window) = describe(hwnd) {
                if window.width > 0 && window.height > 0 {
                    (*(data.0 as *mut Vec<ComputerWindow>)).push(window);
                }
            }
            true.into()
        }
    }
    unsafe { EnumWindows(Some(collect), LPARAM(&mut result as *mut _ as isize)) }
        .map_err(|error| error.to_string())?;
    Ok(result)
}

pub fn activate(hwnd: HWND, cancelled: impl Fn() -> bool) -> Result<(), String> {
    if cancelled() {
        return Err("Window activation was interrupted.".to_owned());
    }
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        if GetForegroundWindow() == hwnd {
            return Ok(());
        }
        let _ = SetForegroundWindow(hwnd);
        if GetForegroundWindow() != hwnd {
            // 后台执行线程可能不能直接取得前台焦点. 临时连接当前前台线程的输入队列,
            // 仅在激活目标窗口期间使用, 无论成功与否都立即断开, 不向用户窗口伪造快捷键.
            let current_thread = GetCurrentThreadId();
            let foreground_thread = GetWindowThreadProcessId(GetForegroundWindow(), None);
            if foreground_thread != 0
                && foreground_thread != current_thread
                && AttachThreadInput(current_thread, foreground_thread, true).as_bool()
            {
                let _ = BringWindowToTop(hwnd);
                let _ = SetForegroundWindow(hwnd);
                let _ = AttachThreadInput(current_thread, foreground_thread, false);
            }
        }
    }
    // Windows 切换焦点和恢复最小化窗口可能稍后才完成. 短暂等待实际焦点, 不把 API 返回值当结果.
    for _ in 0..30 {
        if cancelled() {
            return Err("Window activation was interrupted.".to_owned());
        }
        if unsafe { GetForegroundWindow() } == hwnd {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    Err(
        "Windows refused to activate the target window. Bring it forward and observe again."
            .to_owned(),
    )
}

pub fn same_window(expected: &ComputerWindow) -> Result<HWND, String> {
    let hwnd = handle(&expected.id)?;
    let current = describe(hwnd)?;
    if current.app != expected.app
        || current.x != expected.x
        || current.y != expected.y
        || current.width != expected.width
        || current.height != expected.height
    {
        return Err("The observed window moved, resized, or changed identity.".to_owned());
    }
    Ok(hwnd)
}
