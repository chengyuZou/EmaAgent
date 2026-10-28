use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
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

pub fn activate(hwnd: HWND) -> Result<(), String> {
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        if GetForegroundWindow() == hwnd || SetForegroundWindow(hwnd).as_bool() {
            return Ok(());
        }
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
