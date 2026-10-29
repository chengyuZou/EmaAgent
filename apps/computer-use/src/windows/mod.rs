mod accessibility;
mod capture;
mod input;
#[path = "inputMonitor.rs"]
mod input_monitor;
mod observation;
mod overlay;
mod windows;

#[cfg(test)]
#[path = "../../tests/nativeDesktop.rs"]
mod tests;

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};

use ::windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};
use ::windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};

use crate::types::{ActionParams, ComputerUseParams, ObserveParams, Request, WireMessage};
use observation::Observation;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ComputerUsePhase {
    Running,
    // 已停止接受新输入, 正在等当前请求结束并松开本程序按住的键鼠.
    Ending,
}

struct ActiveComputerUse {
    // Node 传来的这整段电脑操控 ID, 不是每条通信请求的编号.
    control_id: String,
    phase: ComputerUsePhase,
    end_reason: &'static str,
}

struct ComputerUseState {
    // 收到并处理 computer.begin 后才写入. 整段操控结束后变为 None.
    current_active_computer_use: Option<ActiveComputerUse>,
    // 执行线程正在处理的请求编号. None 表示它现在没有执行请求.
    executing_request_id: Option<u64>,
    // Node 要求取消的请求编号, 包括还在排队的请求. 执行线程处理完该请求后删除.
    cancelled_request_ids: HashSet<u64>,
    // 哪些结束请求还没答复. 等当前操作结束并松开键鼠后, 再逐个回复 Node.
    end_request_ids_awaiting_cleanup: Vec<u64>,
}

pub struct SharedComputerUseState {
    // 请求执行线程和键鼠监听线程都会修改这份状态, 一次只能由一个线程修改.
    state: Mutex<ComputerUseState>,
    // 目标窗口中的用户输入或 Agent 动作会改变这个数字. 观察保存的数字不同, 就不能再按旧图操作.
    pub observation_revision: AtomicU64,
    // 提示条的 Windows 窗口句柄. 0 表示窗口尚未创建或已经关闭.
    pub overlay_window_handle: AtomicIsize,
    // 当前正在观察或操作的目标窗口. 0 表示尚未选择目标.
    pub target_window_handle: AtomicIsize,
    // 键鼠监听线程的 Windows 线程号. 0 表示线程尚未启动或已经退出.
    pub input_monitor_thread_id: AtomicU32,
    // Node 关闭请求管道后设为 true, 执行线程据此停止当前操作.
    node_disconnected: AtomicBool,
    // 把回应和状态通知交给 stdout 写入线程, 各线程不直接往 stdout 混写 JSON.
    message_sender: mpsc::Sender<WireMessage>,
}

impl SharedComputerUseState {
    pub fn phase(&self) -> Option<ComputerUsePhase> {
        self.state
            .lock()
            .unwrap()
            .current_active_computer_use
            .as_ref()
            .map(|computer_use| computer_use.phase)
    }

    fn event(&self, id: &str, phase: &str, reason: &str) {
        let _ = self.message_sender.send(WireMessage::Event {
            jsonrpc: "2.0",
            method: "computer.stateChanged",
            params: json!({ "controlId": id, "phase": phase, "reason": reason }),
        });
    }

    // 输入钩子只使目标窗口的旧观察失效, 不改变操控的运行状态.
    pub fn user_input(&self, window: ::windows::Win32::Foundation::HWND) {
        let target = self.target_window_handle.load(Ordering::SeqCst);
        if target != 0 && window.0 as isize == target {
            self.observation_revision.fetch_add(1, Ordering::SeqCst);
        }
    }

    // Node 发来的结束请求带请求编号和 controlId. Esc, 提示条按钮或断线直接结束当前操控,
    // 不需要给某条请求回信, 所以这两个参数可以是 None.
    pub fn end(
        &self,
        reason: &'static str,
        reply_request_id: Option<u64>,
        expected_control_id: Option<&str>,
    ) {
        let mut state = self.state.lock().unwrap();
        if let Some(computer_use) = state.current_active_computer_use.as_mut() {
            if expected_control_id.is_some_and(|id| id != computer_use.control_id) {
                if let Some(id) = reply_request_id {
                    self.reply(id, json!({ "ended": false }));
                }
                return;
            }
            if computer_use.phase != ComputerUsePhase::Ending {
                computer_use.phase = ComputerUsePhase::Ending;
                computer_use.end_reason = reason;
                self.observation_revision.fetch_add(1, Ordering::SeqCst);
                self.event(&computer_use.control_id, "ending", reason);
                overlay::refresh(self);
            }
            if let Some(id) = reply_request_id {
                state.end_request_ids_awaiting_cleanup.push(id);
            }
            if state.executing_request_id.is_none() {
                self.finish_end(&mut state);
            }
        } else if let Some(id) = reply_request_id {
            self.reply(id, json!({ "ended": false }));
        }
    }

    fn finish_end(&self, state: &mut ComputerUseState) {
        self.target_window_handle.store(0, Ordering::SeqCst);
        if let Some(computer_use) = state.current_active_computer_use.take() {
            self.event(&computer_use.control_id, "ended", computer_use.end_reason);
        }
        for id in state.end_request_ids_awaiting_cleanup.drain(..) {
            self.reply(id, json!({ "ended": true }));
        }
        overlay::refresh(self);
    }

    fn reply(&self, id: u64, result: Value) {
        let _ = self.message_sender.send(WireMessage::Result {
            jsonrpc: "2.0",
            id,
            result,
        });
    }

    pub fn interrupted(&self, control_id: &str, observation_revision: u64) -> bool {
        let state = self.state.lock().unwrap();
        self.node_disconnected.load(Ordering::SeqCst)
            || state
                .executing_request_id
                .is_some_and(|id| state.cancelled_request_ids.contains(&id))
            || self.observation_revision.load(Ordering::SeqCst) != observation_revision
            || !state
                .current_active_computer_use
                .as_ref()
                .is_some_and(|computer_use| {
                    computer_use.control_id == control_id
                        && computer_use.phase == ComputerUsePhase::Running
                })
    }

    fn request_cancelled(&self) -> bool {
        let state = self.state.lock().unwrap();
        self.node_disconnected.load(Ordering::SeqCst)
            || state
                .executing_request_id
                .is_some_and(|id| state.cancelled_request_ids.contains(&id))
    }
}

pub struct ComputerUse {
    shared_state: Arc<SharedComputerUseState>,
}

impl ComputerUse {
    pub fn new(message_sender: mpsc::Sender<WireMessage>) -> Result<Self, String> {
        unsafe {
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
        let shared_state = Arc::new(SharedComputerUseState {
            state: Mutex::new(ComputerUseState {
                current_active_computer_use: None,
                executing_request_id: None,
                cancelled_request_ids: HashSet::new(),
                end_request_ids_awaiting_cleanup: Vec::new(),
            }),
            observation_revision: AtomicU64::new(0),
            overlay_window_handle: AtomicIsize::new(0),
            target_window_handle: AtomicIsize::new(0),
            input_monitor_thread_id: AtomicU32::new(0),
            node_disconnected: AtomicBool::new(false),
            message_sender,
        });
        overlay::start(shared_state.clone())?;
        if let Err(error) = input_monitor::start(shared_state.clone()) {
            overlay::close(&shared_state);
            return Err(error);
        }
        Ok(Self { shared_state })
    }

    pub fn handle_control_request(&self, request: &Request) -> bool {
        if request.jsonrpc != "2.0" {
            let _ = self.shared_state.message_sender.send(WireMessage::error(
                request.id,
                -32600,
                "Invalid JSON-RPC version.",
            ));
            return true;
        }
        if request.method == "computer.cancel" {
            if let Some(id) = request.params.get("id").and_then(Value::as_u64) {
                self.shared_state
                    .state
                    .lock()
                    .unwrap()
                    .cancelled_request_ids
                    .insert(id);
            }
            return true;
        }
        if request.method == "computer.end" {
            match serde_json::from_value::<ComputerUseParams>(request.params.clone()) {
                Ok(params) => {
                    let reason = if request.params.get("reason").and_then(Value::as_str)
                        == Some("cancelled")
                    {
                        "cancelled"
                    } else {
                        "agent_end"
                    };
                    self.shared_state
                        .end(reason, request.id, Some(&params.control_id));
                }
                Err(error) => {
                    let _ = self.shared_state.message_sender.send(WireMessage::error(
                        request.id,
                        -32602,
                        &error.to_string(),
                    ));
                }
            }
            return true;
        }
        false
    }

    pub fn run(&self, requests: mpsc::Receiver<Request>) {
        let initialized = unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.is_ok();
        // 只保留最近一次观察及其控件. 动作完成或操控结束后清空, 后续动作必须重新观察.
        let mut observation: Option<Observation> = None;
        let mut observation_number = 0u64;
        for request in requests {
            let Some(id) = request.id else { continue };
            {
                let mut state = self.shared_state.state.lock().unwrap();
                state.executing_request_id = Some(id);
            }
            let result = self.execute(&request, &mut observation, &mut observation_number);
            match result {
                Ok(value) => self.shared_state.reply(id, value),
                Err(error) => {
                    let _ = self.shared_state.message_sender.send(WireMessage::error(
                        Some(id),
                        -32000,
                        &error,
                    ));
                }
            }
            let mut state = self.shared_state.state.lock().unwrap();
            state.executing_request_id = None;
            state.cancelled_request_ids.remove(&id);
            if state
                .current_active_computer_use
                .as_ref()
                .is_some_and(|computer_use| computer_use.phase == ComputerUsePhase::Ending)
            {
                observation = None;
                self.shared_state.finish_end(&mut state);
            }
        }
        if initialized {
            unsafe {
                RoUninitialize();
            }
        }
    }

    fn execute(
        &self,
        request: &Request,
        observation: &mut Option<Observation>,
        number: &mut u64,
    ) -> Result<Value, String> {
        if request.method == "computer.ping" {
            return Ok(json!({ "ok": true }));
        }
        if self.shared_state.request_cancelled() {
            return Err("The request was cancelled before execution.".to_owned());
        }
        match request.method.as_str() {
            "computer.listWindows" => {
                serde_json::to_value(windows::list()?).map_err(|error| error.to_string())
            }
            "computer.begin" => {
                let params: ComputerUseParams = serde_json::from_value(request.params.clone())
                    .map_err(|error| error.to_string())?;
                let mut state = self.shared_state.state.lock().unwrap();
                if let Some(computer_use) = &state.current_active_computer_use {
                    if computer_use.control_id != params.control_id
                        || computer_use.phase == ComputerUsePhase::Ending
                    {
                        return Err("Another computer control is already active.".to_owned());
                    }
                    return Ok(json!({ "started": false }));
                }
                self.shared_state
                    .observation_revision
                    .fetch_add(1, Ordering::SeqCst);
                *observation = None;
                state.current_active_computer_use = Some(ActiveComputerUse {
                    control_id: params.control_id.clone(),
                    phase: ComputerUsePhase::Running,
                    end_reason: "agent_end",
                });
                self.shared_state
                    .event(&params.control_id, "running", "started");
                overlay::refresh(&self.shared_state);
                Ok(json!({ "started": true }))
            }
            "computer.capture" => {
                let image = capture::capture(None, || self.shared_state.request_cancelled())?;
                Ok(json!({ "image": STANDARD.encode(image.png) }))
            }
            "computer.observe" => {
                let params: ObserveParams = serde_json::from_value(request.params.clone())
                    .map_err(|error| error.to_string())?;
                let observation_revision = self
                    .shared_state
                    .observation_revision
                    .load(Ordering::SeqCst);
                if self
                    .shared_state
                    .interrupted(&params.control_id, observation_revision)
                {
                    return Err(
                        "Computer control ended or the observation was invalidated.".to_owned()
                    );
                }
                let hwnd = windows::handle(&params.window_id)?;
                self.shared_state
                    .target_window_handle
                    .store(hwnd.0 as isize, Ordering::SeqCst);
                // 前置失败仍尝试读取指定窗口. 结果明确告知模型, 动作执行前会再次检查焦点.
                let activation_error = windows::activate(hwnd, || {
                    self.shared_state
                        .interrupted(&params.control_id, observation_revision)
                })
                .err();
                let window = windows::describe(hwnd)?;
                let image = capture::capture(Some(hwnd), || {
                    self.shared_state
                        .interrupted(&params.control_id, observation_revision)
                })?;
                let controls = accessibility::AccessibleControls::read(hwnd, &window)
                    .unwrap_or_else(|_| accessibility::AccessibleControls::unavailable());
                if self
                    .shared_state
                    .interrupted(&params.control_id, observation_revision)
                {
                    return Err("User input invalidated this observation.".to_owned());
                }
                *number += 1;
                let id = format!("{}:{}", params.control_id, number);
                let result = json!({
                    "observationId": id,
                    "activationError": activation_error,
                    "controlId": params.control_id,
                    "window": window,
                    "width": image.width,
                    "height": image.height,
                    "image": STANDARD.encode(image.png),
                    "mimeType": "image/png",
                    "elements": controls.elements,
                    "truncated": controls.truncated,
                });
                *observation = Some(Observation {
                    id,
                    control_id: params.control_id,
                    observation_revision,
                    window,
                    width: image.width,
                    height: image.height,
                    controls,
                });
                Ok(result)
            }
            "computer.act" => {
                let params: ActionParams = serde_json::from_value(request.params.clone())
                    .map_err(|error| error.to_string())?;
                {
                    let state = self.shared_state.state.lock().unwrap();
                    let Some(computer_use) = &state.current_active_computer_use else {
                        return Ok(action_result(
                            "control_ended",
                            false,
                            "Computer control has ended. The action was not executed.",
                        ));
                    };
                    if computer_use.control_id != params.control_id
                        || computer_use.phase == ComputerUsePhase::Ending
                    {
                        return Ok(action_result(
                            "control_ended",
                            false,
                            "Computer control has ended. The action was not executed.",
                        ));
                    }
                }
                let Some(observed) = observation.as_ref() else {
                    return Ok(action_result(
                        "observation_expired",
                        false,
                        "Observe the window before acting.",
                    ));
                };
                if observed.id != params.observation_id
                    || observed.control_id != params.control_id
                    || observed.observation_revision
                        != self
                            .shared_state
                            .observation_revision
                            .load(Ordering::SeqCst)
                    || windows::same_window(&observed.window).is_err()
                {
                    return Ok(action_result(
                        "observation_expired",
                        false,
                        "The observation expired. Observe again; do not replay the old action.",
                    ));
                }
                let mut input_may_have_effect = false;
                let result = input::perform(
                    &params.action,
                    observed,
                    &self.shared_state,
                    &mut input_may_have_effect,
                );
                // 每个动作完成后都必须使用新观察, 同批后续动作不能沿用旧坐标.
                self.shared_state
                    .observation_revision
                    .fetch_add(1, Ordering::SeqCst);
                *observation = None;
                match result {
                    Ok(()) => Ok(action_result(
                        "completed",
                        input_may_have_effect,
                        "Input was submitted. Observe the window to verify the application result.",
                    )),
                    Err(error) => Ok(action_result("interrupted", input_may_have_effect, &error)),
                }
            }
            _ => Err("Unknown computer method.".to_owned()),
        }
    }

    pub fn disconnect(&self) {
        self.shared_state
            .node_disconnected
            .store(true, Ordering::SeqCst);
        self.shared_state.end("connection_closed", None, None);
    }

    // 停止键鼠监听并关闭提示条. 两个线程退出后才会释放它们持有的共享状态.
    pub fn close_desktop_ui(&self) {
        input_monitor::stop(&self.shared_state);
        overlay::close(&self.shared_state);
    }
}

fn action_result(status: &str, input_may_have_effect: bool, message: &str) -> Value {
    let effect = if input_may_have_effect {
        "possible"
    } else {
        "none"
    };
    json!({ "status": status, "effect": effect, "message": message })
}
