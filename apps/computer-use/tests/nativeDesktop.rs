use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use ::windows::core::w;
use ::windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use ::windows::Win32::System::LibraryLoader::GetModuleHandleW;
use ::windows::Win32::UI::WindowsAndMessaging::*;
use serde_json::{json, Value};

use super::ComputerUse;
use crate::types::{Request, WireMessage};

struct TestWindow {
    hwnd: isize,
    edit: isize,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl TestWindow {
    fn open() -> Self {
        let (sender, receiver) = mpsc::sync_channel(1);
        let thread = std::thread::spawn(move || unsafe {
            unsafe extern "system" fn window_proc(
                hwnd: HWND,
                message: u32,
                wparam: WPARAM,
                lparam: LPARAM,
            ) -> LRESULT {
                if message == WM_DESTROY {
                    PostQuitMessage(0);
                    return LRESULT(0);
                }
                DefWindowProcW(hwnd, message, wparam, lparam)
            }
            let instance = HINSTANCE(GetModuleHandleW(None).unwrap().0);
            let class = WNDCLASSW {
                lpfnWndProc: Some(window_proc),
                hInstance: instance,
                lpszClassName: w!("EmaComputerUseFixture"),
                ..Default::default()
            };
            RegisterClassW(&class);
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("EmaComputerUseFixture"),
                w!("Ema computer-use test"),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                240,
                240,
                600,
                300,
                None,
                None,
                Some(instance),
                None,
            )
            .unwrap();
            let edit = CreateWindowExW(
                WS_EX_CLIENTEDGE,
                w!("EDIT"),
                w!(""),
                WS_CHILD | WS_VISIBLE | WS_TABSTOP | WINDOW_STYLE(ES_MULTILINE as u32),
                20,
                20,
                520,
                200,
                Some(hwnd),
                None,
                Some(instance),
                None,
            )
            .unwrap();
            let _ = SetForegroundWindow(hwnd);
            sender.send((hwnd.0 as isize, edit.0 as isize)).unwrap();
            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        });
        let (hwnd, edit) = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        Self {
            hwnd,
            edit,
            thread: Some(thread),
        }
    }

    fn text(&self) -> String {
        let mut buffer = vec![0u16; 1024];
        let length =
            unsafe { GetWindowTextW(HWND(self.edit as *mut _), &mut buffer) }.max(0) as usize;
        String::from_utf16_lossy(&buffer[..length])
    }
}

impl Drop for TestWindow {
    fn drop(&mut self) {
        unsafe {
            let _ = PostMessageW(
                Some(HWND(self.hwnd as *mut _)),
                WM_CLOSE,
                WPARAM(0),
                LPARAM(0),
            );
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

struct NativeFixture {
    computer: Arc<ComputerUse>,
    requests: Option<mpsc::Sender<Request>>,
    replies: mpsc::Receiver<WireMessage>,
    worker: Option<std::thread::JoinHandle<()>>,
    next_id: u64,
}

impl NativeFixture {
    fn open() -> Self {
        let (output, replies) = mpsc::channel();
        let computer = Arc::new(ComputerUse::new(output).unwrap());
        let (requests, input) = mpsc::channel();
        let worker_computer = computer.clone();
        let worker = std::thread::spawn(move || worker_computer.run(input));
        Self {
            computer,
            requests: Some(requests),
            replies,
            worker: Some(worker),
            next_id: 1,
        }
    }

    fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        let request = Request {
            jsonrpc: "2.0".to_owned(),
            id: Some(id),
            method: method.to_owned(),
            params,
        };
        if !self.computer.handle_control_request(&request) {
            self.requests.as_ref().unwrap().send(request).unwrap();
        }
        loop {
            match self.replies.recv_timeout(Duration::from_secs(10)).unwrap() {
                WireMessage::Result {
                    id: response,
                    result,
                    ..
                } if response == id => return result,
                WireMessage::Error { error, .. } => {
                    panic!("native error: {}", serde_json::to_string(&error).unwrap())
                }
                _ => {}
            }
        }
    }

    fn observe(&mut self, hwnd: isize) -> Value {
        self.call(
            "computer.observe",
            json!({ "controlId": "native-test", "windowId": hwnd.to_string() }),
        )
    }
}

impl Drop for NativeFixture {
    fn drop(&mut self) {
        self.computer.disconnect();
        self.requests.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        self.computer.close_desktop_ui();
    }
}

#[test]
#[ignore = "需要可交互的 Windows 桌面, 仅操作本测试创建的临时窗口"]
fn native_desktop_round_trip() {
    let mut native = NativeFixture::open();
    let window = TestWindow::open();
    native.call("computer.begin", json!({ "controlId": "native-test" }));
    let observation = native.observe(window.hwnd);
    assert!(observation["image"].as_str().unwrap().len() > 100);
    let editable = observation["elements"]
        .as_array()
        .unwrap()
        .iter()
        .find(|element| element["editable"] == true)
        .expect("fixture edit control must be readable")["id"]
        .clone();
    let result = native.call(
        "computer.act",
        json!({
            "controlId": "native-test", "observationId": observation["observationId"],
            "action": { "type": "focus", "elementId": editable },
        }),
    );
    assert_eq!(result["status"], "completed", "{result}");
    let observation = native.observe(window.hwnd);
    let result = native.call(
        "computer.act",
        json!({
            "controlId": "native-test", "observationId": observation["observationId"],
            "action": { "type": "type", "text": "Ema 中文输入" },
        }),
    );
    assert_eq!(result["status"], "completed", "{result}");
    let deadline = Instant::now() + Duration::from_secs(2);
    while window.text() != "Ema 中文输入" && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(window.text(), "Ema 中文输入");

    let observation = native.observe(window.hwnd);
    native.computer.shared_state.pause();
    let stale_action = json!({
        "controlId": "native-test", "observationId": observation["observationId"],
        "action": { "type": "type", "text": "不得执行" },
    });
    assert_eq!(
        native.call("computer.act", stale_action.clone())["status"],
        "paused_before_start"
    );
    std::thread::sleep(Duration::from_millis(100));
    assert!(native.computer.shared_state.resume());
    assert_eq!(
        native.call("computer.act", stale_action.clone())["status"],
        "observation_expired"
    );
    assert_eq!(window.text(), "Ema 中文输入");
    native.call(
        "computer.end",
        json!({ "controlId": "native-test", "reason": "agent_end" }),
    );
    assert_eq!(
        native.call("computer.act", stale_action)["status"],
        "control_ended"
    );
    assert_eq!(window.text(), "Ema 中文输入");
}
