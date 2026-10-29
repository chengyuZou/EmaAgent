use std::sync::atomic::Ordering;
use std::sync::{mpsc, Arc, OnceLock, Weak};

use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::VK_ESCAPE;
use windows::Win32::UI::WindowsAndMessaging::*;

use super::{input::INPUT_MARKER, overlay, SharedComputerUseState};

// Windows 调用键鼠回调时不能附带业务参数, 回调通过这里找到当前程序的共享状态.
static INPUT_MONITOR_STATE: OnceLock<Weak<SharedComputerUseState>> = OnceLock::new();

// 钩子回调由安装它的线程的消息循环调用. 这个线程只处理钩子, 截图, 输入和提示条绘制都不会推迟键鼠响应.
pub fn start(shared_state: Arc<SharedComputerUseState>) -> Result<(), String> {
    let (ready, result) = mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("computer-use-input".to_owned())
        .spawn(move || unsafe {
            let mut message = MSG::default();
            // 先建立本线程的消息队列, 之后才能用 PostThreadMessageW 通知它退出.
            let _ = PeekMessageW(&mut message, None, WM_USER, WM_USER, PM_NOREMOVE);
            let monitor = match InputMonitor::install(&shared_state) {
                Ok(monitor) => monitor,
                Err(error) => {
                    let _ = ready.send(Err(error));
                    return;
                }
            };
            shared_state
                .input_monitor_thread_id
                .store(GetCurrentThreadId(), Ordering::SeqCst);
            let _ = ready.send(Ok(()));
            // 本线程没有窗口, 消息循环只用来接收钩子回调和退出通知.
            while GetMessageW(&mut message, None, 0, 0).as_bool() {}
            drop(monitor);
            shared_state
                .input_monitor_thread_id
                .store(0, Ordering::SeqCst);
        })
        .map_err(|error| error.to_string())?;
    result.recv().map_err(|error| error.to_string())?
}

pub fn stop(shared_state: &SharedComputerUseState) {
    let thread_id = shared_state.input_monitor_thread_id.load(Ordering::SeqCst);
    if thread_id != 0 {
        unsafe {
            let _ = PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }
}

struct InputMonitor {
    keyboard_hook: HHOOK,
    mouse_hook: HHOOK,
}

impl InputMonitor {
    fn install(shared_state: &Arc<SharedComputerUseState>) -> Result<Self, String> {
        let _ = INPUT_MONITOR_STATE.set(Arc::downgrade(shared_state));
        unsafe {
            let module = GetModuleHandleW(None).map_err(|error| error.to_string())?;
            let instance = HINSTANCE(module.0);
            let keyboard =
                SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), Some(instance), 0)
                    .map_err(|error| error.to_string())?;
            match SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), Some(instance), 0) {
                Ok(mouse) => Ok(Self {
                    keyboard_hook: keyboard,
                    mouse_hook: mouse,
                }),
                Err(error) => {
                    let _ = UnhookWindowsHookEx(keyboard);
                    Err(error.to_string())
                }
            }
        }
    }
}

impl Drop for InputMonitor {
    fn drop(&mut self) {
        unsafe {
            let _ = UnhookWindowsHookEx(self.keyboard_hook);
            let _ = UnhookWindowsHookEx(self.mouse_hook);
        }
    }
}

unsafe extern "system" fn keyboard_hook(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
    if code >= 0 && (message.0 as u32 == WM_KEYDOWN || message.0 as u32 == WM_SYSKEYDOWN) {
        let event = &*(data.0 as *const KBDLLHOOKSTRUCT);
        // 本程序或其他程序注入的按键不算用户亲自操作, 否则 自己的动作会使观察失效.
        if event.dwExtraInfo != INPUT_MARKER && event.flags.0 & LLKHF_INJECTED.0 == 0 {
            if let Some(shared_state) = INPUT_MONITOR_STATE.get().and_then(Weak::upgrade) {
                if shared_state.phase().is_some() {
                    if event.vkCode == VK_ESCAPE.0 as u32 {
                        shared_state.end("user_end", None, None);
                        return LRESULT(1);
                    }
                    shared_state.user_input(GetAncestor(GetForegroundWindow(), GA_ROOT));
                }
            }
        }
    }
    CallNextHookEx(None, code, message, data)
}

unsafe extern "system" fn mouse_hook(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
    if code >= 0 {
        let event = &*(data.0 as *const MSLLHOOKSTRUCT);
        if event.dwExtraInfo != INPUT_MARKER && event.flags & LLMHF_INJECTED == 0 {
            if let Some(shared_state) = INPUT_MONITOR_STATE.get().and_then(Weak::upgrade) {
                // 提示条上的点击交给结束按钮处理, 不再当成一次外部鼠标操作.
                if !overlay::contains_point(&shared_state, event.pt) {
                    match message.0 as u32 {
                        WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_MOUSEWHEEL
                        | WM_MOUSEHWHEEL => {
                            let window = GetAncestor(WindowFromPoint(event.pt), GA_ROOT);
                            shared_state.user_input(window);
                        }
                        _ => {}
                    }
                }
            }
        }
    }
    CallNextHookEx(None, code, message, data)
}
