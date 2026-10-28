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
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::*;

use super::{ComputerUsePhase, SharedComputerUseState};

const UPDATE: u32 = WM_APP + 1;
const RESUME_HOTKEY: i32 = 1;
const RESUME_TIMER: usize = 1;

struct Overlay {
    shared_state: Arc<SharedComputerUseState>,
    // 按钮在提示条窗口内的像素范围, 鼠标松开时据此判断点击了哪个按钮.
    resume_button_bounds: RECT,
    end_button_bounds: RECT,
    // 用户已点继续, 但还在等快捷键/鼠标松开或前一个原生请求结束. 计时器会继续检查.
    resume_requested: bool,
    // Ctrl+Alt+C 是否注册成功. 被其他程序占用时为 false, 仍可点击继续按钮.
    resume_hotkey_registered: bool,
    // 同一状态和 DPI 下提示条图像不变. 操控期间复用已绘制的图像, 操控结束后清空.
    frames: HashMap<FrameKey, OverlayFrame>,
}

// 决定提示条图像的全部条件. 运行时不显示热键提示, 热键字段始终为 false.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct FrameKey {
    paused: bool,
    resume_hotkey_registered: bool,
    dpi: u32,
}

struct OverlayFrame {
    // 预乘透明度的 BGRA 像素, 按行从上到下排列.
    pixels: Vec<u8>,
    width: i32,
    height: i32,
    resume_button_bounds: RECT,
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
            resume_button_bounds: RECT::default(),
            end_button_bounds: RECT::default(),
            resume_requested: false,
            resume_hotkey_registered: false,
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
                    } else if inside(overlay.resume_button_bounds, point)
                        && overlay.shared_state.phase() == Some(ComputerUsePhase::Paused)
                    {
                        request_resume(hwnd, overlay);
                    }
                }
            });
            return LRESULT(0);
        }
        WM_HOTKEY if wparam.0 == RESUME_HOTKEY as usize => {
            OVERLAY.with(|value| {
                if let Some(overlay) = value.borrow_mut().as_mut() {
                    request_resume(hwnd, overlay);
                }
            });
            return LRESULT(0);
        }
        WM_TIMER if wparam.0 == RESUME_TIMER => {
            OVERLAY.with(|value| {
                if let Some(overlay) = value.borrow_mut().as_mut() {
                    // 用户按着 Ctrl+Alt+C 或鼠标点击继续时先等松开, 否则 Agent 的新输入会混进这些按键.
                    let released = [VK_CONTROL, VK_MENU, VK_LBUTTON, VIRTUAL_KEY(b'C' as u16)]
                        .iter()
                        .all(|key| GetAsyncKeyState(key.0 as i32) >= 0);
                    if overlay.resume_requested && released && overlay.shared_state.resume() {
                        overlay.resume_requested = false;
                        let _ = KillTimer(Some(hwnd), RESUME_TIMER);
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
            let _ = UnregisterHotKey(Some(hwnd), RESUME_HOTKEY);
            PostQuitMessage(0);
            return LRESULT(0);
        }
        _ => {}
    }
    DefWindowProcW(hwnd, message, wparam, lparam)
}

unsafe fn request_resume(hwnd: HWND, overlay: &mut Overlay) {
    if overlay.shared_state.phase() == Some(ComputerUsePhase::Paused) {
        overlay.resume_requested = true;
        SetTimer(Some(hwnd), RESUME_TIMER, 20, None);
    }
}

fn inside(rect: RECT, point: POINT) -> bool {
    point.x >= rect.left && point.x < rect.right && point.y >= rect.top && point.y < rect.bottom
}

unsafe fn update(hwnd: HWND, overlay: &mut Overlay) {
    let phase = overlay.shared_state.phase();
    if phase.is_none() || phase == Some(ComputerUsePhase::Ending) {
        let _ = ShowWindow(hwnd, SW_HIDE);
        if overlay.resume_hotkey_registered {
            let _ = UnregisterHotKey(Some(hwnd), RESUME_HOTKEY);
            overlay.resume_hotkey_registered = false;
        }
        overlay.resume_requested = false;
        let _ = KillTimer(Some(hwnd), RESUME_TIMER);
        overlay.frames.clear();
        return;
    }
    let paused = phase == Some(ComputerUsePhase::Paused);
    if paused && !overlay.resume_hotkey_registered {
        overlay.resume_hotkey_registered = RegisterHotKey(
            Some(hwnd),
            RESUME_HOTKEY,
            MOD_CONTROL | MOD_ALT | MOD_NOREPEAT,
            b'C' as u32,
        )
        .is_ok();
    } else if !paused && overlay.resume_hotkey_registered {
        let _ = UnregisterHotKey(Some(hwnd), RESUME_HOTKEY);
        overlay.resume_hotkey_registered = false;
    }
    render(hwnd, overlay, paused);
    let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
}

unsafe fn render(hwnd: HWND, overlay: &mut Overlay, paused: bool) {
    let key = FrameKey {
        paused,
        resume_hotkey_registered: overlay.resume_hotkey_registered,
        dpi: GetDpiForWindow(hwnd).max(96),
    };
    if !overlay.frames.contains_key(&key) {
        let Some(frame) = draw_frame(key) else {
            return;
        };
        overlay.frames.insert(key, frame);
    }
    let frame = &overlay.frames[&key];
    overlay.resume_button_bounds = frame.resume_button_bounds;
    overlay.end_button_bounds = frame.end_button_bounds;
    present(hwnd, frame, key.dpi);
}

unsafe fn draw_frame(key: FrameKey) -> Option<OverlayFrame> {
    let paused = key.paused;
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

    let title = if paused {
        "检测到用户操作, Ema 已暂停"
    } else {
        "Ema 正在操作电脑"
    };
    let hint = if paused {
        if key.resume_hotkey_registered {
            "Ctrl+Alt+C 继续"
        } else {
            "请点击继续"
        }
    } else {
        "按 Esc 结束"
    };
    let title_width = measure(memory, title);
    let hint_width = measure(memory, hint);
    let end_hint_width = measure(memory, "Esc 结束");
    let button_height = px(30);
    let end_width = measure(memory, "结束") + px(24);
    let resume_width = measure(memory, "继续执行") + px(24);
    let row_width = if paused {
        resume_width + hint_width + end_width + end_hint_width + px(44)
    } else {
        hint_width + end_width + px(16)
    };
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
    let (resume_button_bounds, end_button_bounds) = if paused {
        (
            RECT {
                left: row_left,
                top: row_top,
                right: row_left + resume_width,
                bottom: row_top + button_height,
            },
            RECT {
                left: row_left + resume_width + hint_width + px(34),
                top: row_top,
                right: row_left + resume_width + hint_width + px(34) + end_width,
                bottom: row_top + button_height,
            },
        )
    } else {
        (
            RECT::default(),
            RECT {
                left: row_left + hint_width + px(16),
                top: row_top,
                right: row_left + row_width,
                bottom: row_top + button_height,
            },
        )
    };
    if paused {
        paint_button(pixels, width, resume_button_bounds, px(7));
    }
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
    if paused {
        draw_text(memory, "继续执行", resume_button_bounds);
        draw_text(
            memory,
            hint,
            RECT {
                left: resume_button_bounds.right + px(10),
                top: row_top,
                right: resume_button_bounds.right + px(10) + hint_width,
                bottom: row_top + button_height,
            },
        );
        draw_text(
            memory,
            "Esc 结束",
            RECT {
                left: end_button_bounds.right + px(10),
                top: row_top,
                right: row_left + row_width,
                bottom: row_top + button_height,
            },
        );
    } else {
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
    }
    draw_text(memory, "结束", end_button_bounds);
    // GDI 文本可能清零 alpha, 文字只在不透明底板内绘制, 将改变的像素恢复为不透明.
    for (pixel, before) in pixels.chunks_exact_mut(4).zip(before_text.chunks_exact(4)) {
        if pixel[..3] != before[..3] {
            pixel[3] = 255;
        }
    }
    #[cfg(test)]
    export_test_frame(pixels, width, height, paused);
    let frame = OverlayFrame {
        pixels: pixels.to_vec(),
        width,
        height,
        resume_button_bounds,
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
unsafe fn present(hwnd: HWND, frame: &OverlayFrame, dpi: u32) {
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
    let monitor = MonitorFromWindow(GetForegroundWindow(), MONITOR_DEFAULTTOPRIMARY);
    let mut monitor_info = MONITORINFO {
        cbSize: size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    let _ = GetMonitorInfoW(monitor, &mut monitor_info);
    let position = POINT {
        x: monitor_info.rcWork.left
            + (monitor_info.rcWork.right - monitor_info.rcWork.left - frame.width) / 2,
        y: monitor_info.rcWork.top + scaled(8, dpi),
    };
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

#[cfg(test)]
fn export_test_frame(pixels: &[u8], width: i32, height: i32, paused: bool) {
    let Some(directory) = std::env::var_os("EMA_COMPUTER_TEST_IMAGES") else {
        return;
    };
    let mut rgba = Vec::with_capacity(pixels.len());
    for pixel in pixels.chunks_exact(4) {
        let alpha = pixel[3] as u32;
        for channel in [pixel[2], pixel[1], pixel[0]] {
            let straight = if alpha == 0 {
                0
            } else {
                (channel as u32 * 255 / alpha).min(255) as u8
            };
            rgba.push(straight);
        }
        rgba.push(pixel[3]);
    }
    let name = if paused {
        "overlay-paused.png"
    } else {
        "overlay-running.png"
    };
    let path = std::path::PathBuf::from(directory).join(name);
    if let Ok(file) = std::fs::File::create(path) {
        let mut encoder = png::Encoder::new(file, width as u32, height as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        if let Ok(mut writer) = encoder.write_header() {
            let _ = writer.write_image_data(&rgba);
        }
    }
}
