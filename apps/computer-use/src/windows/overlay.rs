use std::cell::RefCell;
use std::collections::HashMap;
use std::mem::size_of;
use std::sync::atomic::Ordering;
use std::sync::{mpsc, Arc};

use windows::core::w;
use windows::Win32::Foundation::{
    COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM,
};
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::WindowsAndMessaging::*;

use super::{ComputerUsePhase, SharedComputerUseState};

const UPDATE: u32 = WM_APP + 1;
const POSITION_TIMER: usize = 1;

struct Overlay {
    shared_state: Arc<SharedComputerUseState>,
    // 按钮在提示条窗口内的像素范围, 鼠标松开时据此判断点击了哪个按钮.
    end_button_bounds: RECT,
    corners: Vec<HWND>,
    // 上次绘制所在的显示器范围. 未改变时只调整置顶顺序, 不重复上传像素.
    monitor_bounds: Option<RECT>,
    // 同一 DPI 下提示条图像不变. 操控期间复用已绘制的图像, 操控结束后清空.
    frames: HashMap<FrameKey, OverlayFrame>,
}

// 图像只随 DPI 变化, 没有暂停或恢复布局.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct FrameKey {
    dpi: u32,
}

struct OverlayFrame {
    // 预乘透明度的 BGRA 像素, 按行从上到下排列.
    pixels: Vec<u8>,
    width: i32,
    height: i32,
    end_button_bounds: RECT,
}

thread_local! {
    static OVERLAY: RefCell<Option<Overlay>> = const { RefCell::new(None) };
}

pub fn start(shared_state: Arc<SharedComputerUseState>) -> Result<(), String> {
    let (ready, result) = mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("computer-use-ui".to_owned())
        .spawn(move || unsafe {
            let result = create(shared_state.clone());
            let hwnd = match result {
                Ok(hwnd) => hwnd,
                Err(error) => {
                    let _ = ready.send(Err(error));
                    return;
                }
            };
            shared_state
                .overlay_window_handle
                .store(hwnd.0 as isize, Ordering::SeqCst);
            let _ = ready.send(Ok(()));
            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            shared_state
                .overlay_window_handle
                .store(0, Ordering::SeqCst);
            OVERLAY.with(|value| {
                value.borrow_mut().take();
            });
        })
        .map_err(|error| error.to_string())?;
    result.recv().map_err(|error| error.to_string())?
}

pub fn refresh(shared_state: &SharedComputerUseState) {
    let hwnd = shared_state.overlay_window_handle.load(Ordering::SeqCst);
    if hwnd != 0 {
        unsafe {
            let _ = PostMessageW(Some(HWND(hwnd as *mut _)), UPDATE, WPARAM(0), LPARAM(0));
        }
    }
}

pub fn close(shared_state: &SharedComputerUseState) {
    let hwnd = shared_state.overlay_window_handle.load(Ordering::SeqCst);
    if hwnd != 0 {
        unsafe {
            let _ = PostMessageW(Some(HWND(hwnd as *mut _)), WM_CLOSE, WPARAM(0), LPARAM(0));
        }
    }
}

pub fn contains_point(shared_state: &SharedComputerUseState, point: POINT) -> bool {
    let hwnd = shared_state.overlay_window_handle.load(Ordering::SeqCst);
    if hwnd == 0 {
        return false;
    }
    unsafe {
        let hwnd = HWND(hwnd as *mut _);
        if !IsWindowVisible(hwnd).as_bool() {
            return false;
        }
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return false;
        }
        point.x >= rect.left && point.x < rect.right && point.y >= rect.top && point.y < rect.bottom
    }
}

unsafe fn create(shared_state: Arc<SharedComputerUseState>) -> Result<HWND, String> {
    let module = GetModuleHandleW(None).map_err(|error| error.to_string())?;
    let instance = HINSTANCE(module.0);
    let class = WNDCLASSW {
        lpfnWndProc: Some(window_proc),
        hInstance: instance,
        hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
        lpszClassName: w!("EmaComputerUseOverlay"),
        ..Default::default()
    };
    RegisterClassW(&class);
    OVERLAY.with(|value| {
        *value.borrow_mut() = Some(Overlay {
            shared_state,
            end_button_bounds: RECT::default(),
            corners: Vec::new(),
            monitor_bounds: None,
            frames: HashMap::new(),
        });
    });
    let hwnd = CreateWindowExW(
        WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_LAYERED,
        w!("EmaComputerUseOverlay"),
        w!("Ema computer use"),
        WS_POPUP,
        0,
        0,
        1,
        1,
        None,
        None,
        Some(instance),
        None,
    )
    .map_err(|error| error.to_string())?;
    let _ = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
    Ok(hwnd)
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_MOUSEACTIVATE => return LRESULT(MA_NOACTIVATE as isize),
        UPDATE | WM_DISPLAYCHANGE | WM_DPICHANGED => {
            OVERLAY.with(|value| {
                match value.try_borrow_mut() {
                    Ok(mut value) => {
                        if let Some(overlay) = value.as_mut() {
                            overlay.monitor_bounds = None;
                            update(hwnd, overlay);
                        }
                    }
                    Err(_) => {
                        // 移动提示条可能当场触发 DPI 通知. 当前绘制还没结束, 等下一条消息再调整.
                        let _ = PostMessageW(Some(hwnd), UPDATE, WPARAM(0), LPARAM(0));
                    }
                }
            });
            return LRESULT(0);
        }
        WM_LBUTTONUP => {
            let point = POINT {
                x: (lparam.0 as u16) as i16 as i32,
                y: ((lparam.0 >> 16) as u16) as i16 as i32,
            };
            OVERLAY.with(|value| {
                if let Some(overlay) = value.borrow_mut().as_mut() {
                    if inside(overlay.end_button_bounds, point) {
                        overlay.shared_state.end("user_end", None, None);
                    }
                }
            });
            return LRESULT(0);
        }
        WM_TIMER if wparam.0 == POSITION_TIMER => {
            OVERLAY.with(|value| {
                if let Ok(mut value) = value.try_borrow_mut() {
                    if let Some(overlay) = value.as_mut() {
                        update(hwnd, overlay);
                    }
                }
            });
            return LRESULT(0);
        }
        WM_CLOSE => {
            let _ = DestroyWindow(hwnd);
            return LRESULT(0);
        }
        WM_DESTROY => {
            let _ = KillTimer(Some(hwnd), POSITION_TIMER);
            OVERLAY.with(|value| {
                if let Some(overlay) = value.borrow_mut().as_mut() {
                    for corner in overlay.corners.drain(..) {
                        let _ = DestroyWindow(corner);
                    }
                }
            });
            PostQuitMessage(0);
            return LRESULT(0);
        }
        _ => {}
    }
    DefWindowProcW(hwnd, message, wparam, lparam)
}

fn inside(rect: RECT, point: POINT) -> bool {
    point.x >= rect.left && point.x < rect.right && point.y >= rect.top && point.y < rect.bottom
}

unsafe fn update(hwnd: HWND, overlay: &mut Overlay) {
    if overlay.shared_state.phase() != Some(ComputerUsePhase::Running) {
        let _ = ShowWindow(hwnd, SW_HIDE);
        for corner in &overlay.corners {
            let _ = ShowWindow(*corner, SW_HIDE);
        }
        let _ = KillTimer(Some(hwnd), POSITION_TIMER);
        overlay.monitor_bounds = None;
        overlay.frames.clear();
        return;
    }
    let monitor = MonitorFromWindow(GetForegroundWindow(), MONITOR_DEFAULTTOPRIMARY);
    let mut info = MONITORINFO {
        cbSize: size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !GetMonitorInfoW(monitor, &mut info).as_bool() {
        return;
    }
    let bounds = info.rcMonitor;
    let changed = overlay.monitor_bounds.map_or(true, |old| {
        old.left != bounds.left
            || old.top != bounds.top
            || old.right != bounds.right
            || old.bottom != bounds.bottom
    });
    let key = FrameKey {
        dpi: GetDpiForWindow(hwnd).max(96),
    };
    if changed || !overlay.frames.contains_key(&key) {
        if !overlay.frames.contains_key(&key) {
            let Some(frame) = draw_frame(key) else {
                return;
            };
            overlay.frames.insert(key, frame);
        }
        let frame = &overlay.frames[&key];
        overlay.end_button_bounds = frame.end_button_bounds;
        present(
            hwnd,
            frame,
            POINT {
                x: info.rcWork.left + (info.rcWork.right - info.rcWork.left - frame.width) / 2,
                y: info.rcWork.top + scaled(8, key.dpi),
            },
        );
        draw_corners(overlay, bounds, key.dpi);
        overlay.monitor_bounds = Some(bounds);
    }
    // 其他置顶窗口可能后来盖在上面. 只调整 Z 顺序, 不激活窗口或重新绘图.
    for window in overlay.corners.iter().copied().chain(std::iter::once(hwnd)) {
        let _ = SetWindowPos(
            window,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
        );
        let _ = ShowWindow(window, SW_SHOWNOACTIVATE);
    }
    SetTimer(Some(hwnd), POSITION_TIMER, 250, None);
}

unsafe extern "system" fn glow_window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    DefWindowProcW(hwnd, message, wparam, lparam)
}

unsafe fn draw_corners(overlay: &mut Overlay, bounds: RECT, dpi: u32) {
    if overlay.corners.is_empty() {
        let instance = HINSTANCE(GetModuleHandleW(None).unwrap_or_default().0);
        RegisterClassW(&WNDCLASSW {
            lpfnWndProc: Some(glow_window_proc),
            hInstance: instance,
            lpszClassName: w!("EmaComputerUseGlow"),
            ..Default::default()
        });
        for _ in 0..4 {
            if let Ok(window) = CreateWindowExW(
                WS_EX_TOPMOST
                    | WS_EX_NOACTIVATE
                    | WS_EX_TOOLWINDOW
                    | WS_EX_LAYERED
                    | WS_EX_TRANSPARENT,
                w!("EmaComputerUseGlow"),
                w!(""),
                WS_POPUP,
                0,
                0,
                1,
                1,
                None,
                None,
                Some(instance),
                None,
            ) {
                let _ = SetWindowDisplayAffinity(window, WDA_EXCLUDEFROMCAPTURE);
                overlay.corners.push(window);
            }
        }
    }
    let size = scaled(150, dpi);
    let spread = scaled(18, dpi) as f64;
    for (index, hwnd) in overlay.corners.iter().enumerate() {
        let right = index % 2 == 1;
        let bottom = index >= 2;
        let mut pixels = vec![0; (size * size * 4) as usize];
        for y in 0..size {
            for x in 0..size {
                let dx = if right { size - 1 - x } else { x } as f64;
                let dy = if bottom { size - 1 - y } else { y } as f64;
                let fade = (1.0 - dx.max(dy) / size as f64).max(0.0);
                let alpha =
                    (150.0 * (-dx.min(dy).powi(2) / (2.0 * spread.powi(2))).exp() * fade) as u8;
                let offset = ((y * size + x) * 4) as usize;
                pixels[offset..offset + 4].copy_from_slice(&[
                    (238 * alpha as u16 / 255) as u8,
                    (175 * alpha as u16 / 255) as u8,
                    0,
                    alpha,
                ]);
            }
        }
        present(
            *hwnd,
            &OverlayFrame {
                pixels,
                width: size,
                height: size,
                end_button_bounds: RECT::default(),
            },
            POINT {
                x: if right {
                    bounds.right - size
                } else {
                    bounds.left
                },
                y: if bottom {
                    bounds.bottom - size
                } else {
                    bounds.top
                },
            },
        );
    }
}

unsafe fn draw_frame(key: FrameKey) -> Option<OverlayFrame> {
    let px = |value: i32| scaled(value, key.dpi);
    let screen = GetDC(None);
    let memory = CreateCompatibleDC(Some(screen));
    let font = CreateFontW(
        -px(16),
        0,
        0,
        0,
        500,
        0,
        0,
        0,
        DEFAULT_CHARSET,
        OUT_DEFAULT_PRECIS,
        CLIP_DEFAULT_PRECIS,
        ANTIALIASED_QUALITY,
        DEFAULT_PITCH.0 as u32,
        w!("Microsoft YaHei UI"),
    );
    let old_font = SelectObject(memory, font.into());

    let title = "Ema 正在操作电脑";
    let hint = "按 Esc 结束";
    let title_width = measure(memory, title);
    let hint_width = measure(memory, hint);
    let button_height = px(30);
    let end_width = measure(memory, "结束") + px(24);
    let row_width = hint_width + end_width + px(16);
    let glow = px(18);
    let width = title_width.max(row_width) + px(40) + glow * 2;
    let height = px(92) + glow * 2;

    let info = bitmap_info(width, height);
    let mut bits = std::ptr::null_mut();
    let bitmap = match CreateDIBSection(Some(memory), &info, DIB_RGB_COLORS, &mut bits, None, 0) {
        Ok(bitmap) => bitmap,
        Err(_) => {
            SelectObject(memory, old_font);
            let _ = DeleteObject(font.into());
            let _ = DeleteDC(memory);
            ReleaseDC(None, screen);
            return None;
        }
    };
    let old_bitmap = SelectObject(memory, bitmap.into());
    let pixels = std::slice::from_raw_parts_mut(bits as *mut u8, (width * height * 4) as usize);
    let panel = RECT {
        left: glow,
        top: glow,
        right: width - glow,
        bottom: height - glow,
    };
    for y in 0..height {
        for x in 0..width {
            let distance = rounded_distance(x as f64, y as f64, panel, px(12) as f64);
            let alpha = if distance <= 0.0 {
                255.0
            } else {
                105.0 * (-distance * distance / (2.0 * (px(7) as f64).powi(2))).exp()
            };
            let offset = ((y * width + x) * 4) as usize;
            // Windows 要求颜色先乘透明度, 按 BGRA 顺序写入. 这里使用固定亮蓝色.
            pixels[offset] = (238.0 * alpha / 255.0) as u8;
            pixels[offset + 1] = (175.0 * alpha / 255.0) as u8;
            pixels[offset + 2] = 0;
            pixels[offset + 3] = alpha as u8;
        }
    }
    let row_top = glow + px(48);
    let row_left = (width - row_width) / 2;

    let end_button_bounds = RECT {
        left: row_left + hint_width + px(16),
        top: row_top,
        right: row_left + row_width,
        bottom: row_top + button_height,
    };
    paint_button(pixels, width, end_button_bounds, px(7));
    let before_text = pixels.to_vec();
    SetBkMode(memory, TRANSPARENT);
    SetTextColor(memory, COLORREF(0x00FF_FFFF));
    draw_text(
        memory,
        title,
        RECT {
            left: 0,
            top: glow + px(10),
            right: width,
            bottom: glow + px(38),
        },
    );

    draw_text(
        memory,
        hint,
        RECT {
            left: row_left,
            top: row_top,
            right: row_left + hint_width,
            bottom: row_top + button_height,
        },
    );
    draw_text(memory, "结束", end_button_bounds);
    // GDI 文本可能清零 alpha, 文字只在不透明底板内绘制, 将改变的像素恢复为不透明.
    for (pixel, before) in pixels.chunks_exact_mut(4).zip(before_text.chunks_exact(4)) {
        if pixel[..3] != before[..3] {
            pixel[3] = 255;
        }
    }
    let frame = OverlayFrame {
        pixels: pixels.to_vec(),
        width,
        height,
        end_button_bounds,
    };
    SelectObject(memory, old_bitmap);
    SelectObject(memory, old_font);
    let _ = DeleteObject(bitmap.into());
    let _ = DeleteObject(font.into());
    let _ = DeleteDC(memory);
    ReleaseDC(None, screen);
    Some(frame)
}

// 图像可以复用, 位置每次重新计算, 提示条跟随前台窗口所在的显示器.
unsafe fn present(hwnd: HWND, frame: &OverlayFrame, position: POINT) {
    let screen = GetDC(None);
    let memory = CreateCompatibleDC(Some(screen));
    let info = bitmap_info(frame.width, frame.height);
    let mut bits = std::ptr::null_mut();
    let bitmap = match CreateDIBSection(Some(memory), &info, DIB_RGB_COLORS, &mut bits, None, 0) {
        Ok(bitmap) => bitmap,
        Err(_) => {
            let _ = DeleteDC(memory);
            ReleaseDC(None, screen);
            return;
        }
    };
    std::slice::from_raw_parts_mut(bits as *mut u8, frame.pixels.len())
        .copy_from_slice(&frame.pixels);
    let old_bitmap = SelectObject(memory, bitmap.into());
    let blend = BLENDFUNCTION {
        BlendOp: AC_SRC_OVER as u8,
        BlendFlags: 0,
        SourceConstantAlpha: 255,
        AlphaFormat: AC_SRC_ALPHA as u8,
    };
    let _ = UpdateLayeredWindow(
        hwnd,
        Some(screen),
        Some(&position),
        Some(&SIZE {
            cx: frame.width,
            cy: frame.height,
        }),
        Some(memory),
        Some(&POINT::default()),
        COLORREF(0),
        Some(&blend),
        ULW_ALPHA,
    );
    let _ = SetWindowPos(
        hwnd,
        Some(HWND_TOPMOST),
        position.x,
        position.y,
        frame.width,
        frame.height,
        SWP_NOACTIVATE,
    );
    SelectObject(memory, old_bitmap);
    let _ = DeleteObject(bitmap.into());
    let _ = DeleteDC(memory);
    ReleaseDC(None, screen);
}

fn bitmap_info(width: i32, height: i32) -> BITMAPINFO {
    BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            // 负高度表示像素按行从上到下排列.
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    }
}

// 按 DPI 把 96 DPI 下的设计尺寸换算成物理像素.
fn scaled(value: i32, dpi: u32) -> i32 {
    (value as f64 * (dpi as f64 / 96.0)).round() as i32
}

fn rounded_distance(x: f64, y: f64, rect: RECT, radius: f64) -> f64 {
    let cx = (rect.left + rect.right) as f64 / 2.0;
    let cy = (rect.top + rect.bottom) as f64 / 2.0;
    let dx = (x - cx).abs() - (rect.right - rect.left) as f64 / 2.0 + radius;
    let dy = (y - cy).abs() - (rect.bottom - rect.top) as f64 / 2.0 + radius;
    dx.max(0.0).hypot(dy.max(0.0)) + dx.max(dy).min(0.0) - radius
}

fn paint_button(pixels: &mut [u8], width: i32, rect: RECT, radius: i32) {
    for y in rect.top..rect.bottom {
        for x in rect.left..rect.right {
            if rounded_distance(x as f64, y as f64, rect, radius as f64) <= 0.0 {
                let offset = ((y * width + x) * 4) as usize;
                pixels[offset..offset + 4].copy_from_slice(&[208, 130, 0, 255]);
            }
        }
    }
}

unsafe fn measure(dc: HDC, text: &str) -> i32 {
    let text: Vec<u16> = text.encode_utf16().collect();
    let mut size = SIZE::default();
    let _ = GetTextExtentPoint32W(dc, &text, &mut size);
    size.cx
}

unsafe fn draw_text(dc: HDC, text: &str, mut rect: RECT) {
    let mut text: Vec<u16> = text.encode_utf16().collect();
    DrawTextW(
        dc,
        &mut text,
        &mut rect,
        DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX,
    );
}
