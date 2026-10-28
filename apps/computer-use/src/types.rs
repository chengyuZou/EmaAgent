use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
pub struct Request {
    pub jsonrpc: String,
    // Node 用这个数字匹配回应. None 表示通知, 例如取消请求, 不需要单独回应.
    pub id: Option<u64>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum WireMessage {
    Result {
        jsonrpc: &'static str,
        id: u64,
        result: Value,
    },
    Error {
        jsonrpc: &'static str,
        // 请求本身解析失败时可能拿不到编号, 此时为 None.
        id: Option<u64>,
        error: RpcError,
    },
    Event {
        jsonrpc: &'static str,
        method: &'static str,
        params: Value,
    },
}

#[derive(Serialize)]
pub struct RpcError {
    code: i32,
    message: String,
}

impl WireMessage {
    pub fn error(id: Option<u64>, code: i32, message: &str) -> Self {
        Self::Error {
            jsonrpc: "2.0",
            id,
            error: RpcError {
                code,
                message: message.to_owned(),
            },
        }
    }
}

#[derive(Clone, Serialize)]
pub struct ComputerWindow {
    // Windows 窗口句柄转成的字符串. Node 后续观察时原样传回.
    pub id: String,
    pub title: String,
    // 窗口所属程序的路径, 无法读取时为 pid:<进程号>.
    pub app: String,
    // 桌面物理像素, 次显示器可能位于主显示器左侧或上方.
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Clone, Serialize)]
pub struct ComputerElement {
    // 只对本次观察有效的序号, 不能跨 observationId 使用.
    pub id: usize,
    pub name: String,
    pub role: String,
    pub enabled: bool,
    pub editable: bool,
    pub invokable: bool,
    // 相对窗口截图左上角的物理像素位置和尺寸, 不是桌面绝对坐标.
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Action {
    Click {
        x: f64,
        y: f64,
        button: String,
        count: u32,
    },
    Move {
        x: f64,
        y: f64,
    },
    Scroll {
        x: f64,
        y: f64,
        // Windows 滚轮单位, 120 为一格. horizontal 正值向右, vertical 正值向下.
        horizontal: i32,
        vertical: i32,
    },
    Drag {
        x: f64,
        y: f64,
        #[serde(rename = "toX")]
        to_x: f64,
        #[serde(rename = "toY")]
        to_y: f64,
        #[serde(rename = "durationMs")]
        duration_ms: u64,
    },
    Type {
        text: String,
    },
    Key {
        keys: String,
    },
    SetValue {
        #[serde(rename = "elementId")]
        element_id: usize,
        text: String,
    },
    Invoke {
        #[serde(rename = "elementId")]
        element_id: usize,
    },
    Focus {
        #[serde(rename = "elementId")]
        element_id: usize,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUseParams {
    // 整段电脑操控的 ID, 开始和结束必须指向同一次操控.
    pub control_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObserveParams {
    pub control_id: String,
    pub window_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionParams {
    pub control_id: String,
    pub observation_id: String,
    pub action: Action,
}
