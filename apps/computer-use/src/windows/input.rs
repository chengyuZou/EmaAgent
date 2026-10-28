use std::mem::size_of;
use std::time::Duration;

use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::*;

use super::{observation::Observation, windows as target_windows, SharedComputerUseState};
use crate::types::Action;

// 所有本程序注入的输入都携带该标记, 监听器不能将自己的动作误认为用户接管.
// 0x45 0x4D 0x41 正好是 ASCII 的 E M A 
// 0x01 不是可打印字符，而是控制字符 SOH
pub const INPUT_MARKER: usize = 0x454D_4101;

pub fn perform(
    action: &Action,
    observed: &Observation,
    shared_state: &SharedComputerUseState,
    // 一旦开始向 Windows 提交键鼠或控件操作就设为 true. 后面失败也可能已经产生部分效果.
    input_may_have_effect: &mut bool,
) -> Result<(), String> {
    let check = || {
        if shared_state.interrupted(&observed.control_id, observed.observation_revision) {
            Err("User input interrupted this action. It may be partially complete; observe again before continuing.".to_owned())
        } else {
            Ok(())
        }
    };
    check()?;
    let hwnd = target_windows::same_window(&observed.window)?;
    target_windows::activate(hwnd)?;
    target_windows::same_window(&observed.window)?;
    check()?;

    match action {
        Action::SetValue { .. } | Action::Invoke { .. } | Action::Focus { .. } => {
            // COM 调用一旦开始, 无法保证目标应用没有产生效果, 失败也不能自动重试.
            *input_may_have_effect = true;
            observed.controls.perform(action)?;
        }
        Action::Type { text } => {
            ensure_focus(hwnd)?;
            if text.chars().count() > 20000 {
                return Err("Text is too long.".to_owned());
            }
            for character in text.chars() {
                check()?;
                ensure_focus(hwnd)?;
                let mut buffer = [0u16; 2];
                // 一个字符可能占两个 UTF-16 单元, 整个字符的按下/松开一起提交.
                let units = character.encode_utf16(&mut buffer);
                let mut events = Vec::with_capacity(units.len() * 2);
                for unit in units.iter() {
                    events.push(key_input(0, *unit, KEYEVENTF_UNICODE));
                    events.push(key_input(0, *unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
                }
                *input_may_have_effect = true;
                send(&events)?;
            }
        }
        Action::Key { keys } => {
            let keys = parse_keys(keys)?;
            let mut held = Vec::new();
            let result: Result<(), String> = (|| {
                for key in &keys {
                    check()?;
                    *input_may_have_effect = true;
                    held.push(*key);
                    send(&[key_input(*key, 0, KEYBD_EVENT_FLAGS(0))])?;
                }
                Ok(())
            })();
            // 释放属于本次动作的键, 即使用户已经暂停或结束控制也必须清理.
            let mut release_error = None;
            for key in held.into_iter().rev() {
                if let Err(error) = send(&[key_input(key, 0, KEYEVENTF_KEYUP)]) {
                    release_error = Some(error);
                }
            }
            result?;
            if let Some(error) = release_error {
                return Err(error);
            }
        }
        Action::Move { x, y } => {
            let point = observed.desktop_point(*x, *y)?;
            ensure_point(hwnd, point)?;
            check()?;
            *input_may_have_effect = true;
            move_pointer(point)?;
        }
        Action::Click {
            x,
            y,
            button,
            count,
        } => {
            if !(1..=2).contains(count) {
                return Err("Click count must be 1 or 2.".to_owned());
            }
            let (down, up) = button_flags(button)?;
            let point = observed.desktop_point(*x, *y)?;
            ensure_point(hwnd, point)?;
            for _ in 0..*count {
                check()?;
                *input_may_have_effect = true;
                move_pointer(point)?;
                check()?;
                let result = send(&[mouse_input(0, 0, 0, down)]);
                let released = send(&[mouse_input(0, 0, 0, up)]);
                result?;
                released?;
            }
        }
        Action::Scroll {
            x,
            y,
            horizontal,
            vertical,
        } => {
            let point = observed.desktop_point(*x, *y)?;
            ensure_point(hwnd, point)?;
            check()?;
            if horizontal.abs() > 12000 || vertical.abs() > 12000 {
                return Err("Scroll delta is too large.".to_owned());
            }
            *input_may_have_effect = true;
            move_pointer(point)?;
            if *vertical != 0 {
                check()?;
                send(&[mouse_input(0, 0, (-vertical) as u32, MOUSEEVENTF_WHEEL)])?;
            }
            if *horizontal != 0 {
                check()?;
                send(&[mouse_input(0, 0, *horizontal as u32, MOUSEEVENTF_HWHEEL)])?;
            }
        }
        Action::Drag {
            x,
            y,
            to_x,
            to_y,
            duration_ms,
        } => {
            if !(100..=5000).contains(duration_ms) {
                return Err("Drag duration must be 100..5000 ms.".to_owned());
            }
            let from = observed.desktop_point(*x, *y)?;
            let to = observed.desktop_point(*to_x, *to_y)?;
            ensure_point(hwnd, from)?;
            check()?;
            *input_may_have_effect = true;
            move_pointer(from)?;
            let result: Result<(), String> = (|| {
                send(&[mouse_input(0, 0, 0, MOUSEEVENTF_LEFTDOWN)])?;
                let steps = (duration_ms / 16).max(1);
                for step in 1..=steps {
                    check()?;
                    let fraction = step as f64 / steps as f64;
                    move_pointer((
                        from.0 + ((to.0 - from.0) as f64 * fraction).round() as i32,
                        from.1 + ((to.1 - from.1) as f64 * fraction).round() as i32,
                    ))?;
                    std::thread::sleep(Duration::from_millis(duration_ms / steps));
                }
                Ok(())
            })();
            let released = send(&[mouse_input(0, 0, 0, MOUSEEVENTF_LEFTUP)]);
            result?;
            released?;
        }
    }
    check()
}

fn ensure_focus(hwnd: HWND) -> Result<(), String> {
    unsafe {
        let mut info = GUITHREADINFO {
            cbSize: size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        GetGUIThreadInfo(0, &mut info).map_err(|error| error.to_string())?;
        if info.hwndFocus.0.is_null() || GetAncestor(info.hwndFocus, GA_ROOT) != hwnd {
            return Err("The target editor does not have keyboard focus. Observe and focus it before typing.".to_owned());
        }
    }
    Ok(())
}

fn ensure_point(hwnd: HWND, point: (i32, i32)) -> Result<(), String> {
    let actual = unsafe {
        WindowFromPoint(POINT {
            x: point.0,
            y: point.1,
        })
    };
    if unsafe { GetAncestor(actual, GA_ROOT) } != hwnd {
        return Err(
            "The point is covered by another window. Observe again before clicking.".to_owned(),
        );
    }
    Ok(())
}

fn key_input(key: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    let flags = match VIRTUAL_KEY(key) {
        VK_LEFT | VK_RIGHT | VK_UP | VK_DOWN | VK_HOME | VK_END | VK_PRIOR | VK_NEXT
        | VK_INSERT | VK_DELETE | VK_LWIN | VK_RWIN => flags | KEYEVENTF_EXTENDEDKEY,
        _ => flags,
    };
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(key),
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: INPUT_MARKER,
            },
        },
    }
}

fn mouse_input(x: i32, y: i32, data: u32, flags: MOUSE_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: x,
                dy: y,
                mouseData: data,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: INPUT_MARKER,
            },
        },
    }
}

fn move_pointer(point: (i32, i32)) -> Result<(), String> {
    unsafe {
        let left = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let top = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        if width < 2 || height < 2 {
            return Err("No usable desktop bounds.".to_owned());
        }
        let x = (((point.0 - left) as f64 * 65535.0) / (width - 1) as f64).round() as i32;
        let y = (((point.1 - top) as f64 * 65535.0) / (height - 1) as f64).round() as i32;
        send(&[mouse_input(
            x,
            y,
            0,
            MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
        )])
    }
}

fn send(events: &[INPUT]) -> Result<(), String> {
    let sent = unsafe { SendInput(events, size_of::<INPUT>() as i32) };
    if sent as usize != events.len() {
        return Err(format!(
            "Windows accepted {sent}/{} input events. The action may be partial.",
            events.len()
        ));
    }
    Ok(())
}

fn button_flags(button: &str) -> Result<(MOUSE_EVENT_FLAGS, MOUSE_EVENT_FLAGS), String> {
    match button {
        "left" => Ok((MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)),
        "right" => Ok((MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)),
        "middle" => Ok((MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP)),
        _ => Err("Unknown mouse button.".to_owned()),
    }
}

fn parse_keys(chord: &str) -> Result<Vec<u16>, String> {
    let mut result = Vec::new();
    for key in chord.split('+').map(str::trim) {
        let upper = key.to_uppercase();
        let code = match upper.as_str() {
            "CTRL" | "CONTROL" => VK_CONTROL.0,
            "ALT" => VK_MENU.0,
            "SHIFT" => VK_SHIFT.0,
            "WIN" | "WINDOWS" => VK_LWIN.0,
            "ENTER" | "RETURN" => VK_RETURN.0,
            "TAB" => VK_TAB.0,
            "ESC" | "ESCAPE" => VK_ESCAPE.0,
            "BACKSPACE" => VK_BACK.0,
            "DELETE" => VK_DELETE.0,
            "SPACE" => VK_SPACE.0,
            "LEFT" => VK_LEFT.0,
            "RIGHT" => VK_RIGHT.0,
            "UP" => VK_UP.0,
            "DOWN" => VK_DOWN.0,
            "HOME" => VK_HOME.0,
            "END" => VK_END.0,
            "PAGEUP" => VK_PRIOR.0,
            "PAGEDOWN" => VK_NEXT.0,
            _ => {
                if upper.len() == 1 && upper.as_bytes()[0].is_ascii_alphanumeric() {
                    upper.as_bytes()[0] as u16
                } else if let Some(number) = upper
                    .strip_prefix('F')
                    .and_then(|value| value.parse::<u16>().ok())
                    .filter(|number| (1..=24).contains(number))
                {
                    VK_F1.0 + number - 1
                } else {
                    return Err(format!("Unsupported key: {key}"));
                }
            }
        };
        if result.contains(&code) || result.len() >= 5 {
            return Err("Invalid keyboard chord.".to_owned());
        }
        result.push(code);
    }
    if result.is_empty() {
        return Err("A keyboard chord is required.".to_owned());
    }
    Ok(result)
}
