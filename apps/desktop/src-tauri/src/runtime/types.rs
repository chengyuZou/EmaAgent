// 定义桌面运行时、LocalHost 与 Narrative Bridge 生命周期对外可见的状态结构。
use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeService {
    LocalHost,
    NarrativeBridge,
}

impl RuntimeService {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LocalHost => "local-host",
            Self::NarrativeBridge => "narrative-bridge",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimePhase {
    Stopped,
    StartingNarrativeBridge,
    StartingLocalHost,
    Ready,
    Stopping,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ServicePhase {
    Stopped,
    Starting,
    Ready,
    Unavailable,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceSnapshot {
    pub phase: ServicePhase,
    pub pid: Option<u32>,
    pub port: Option<u16>,
    pub error: Option<String>,
}

impl ServiceSnapshot {
    pub fn stopped() -> Self {
        Self {
            phase: ServicePhase::Stopped,
            pid: None,
            port: None,
            error: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    pub generation: u64,
    pub phase: RuntimePhase,
    pub local_host: ServiceSnapshot,
    pub narrative_bridge: ServiceSnapshot,
    pub last_error: Option<String>,
}

impl RuntimeSnapshot {
    pub fn stopped() -> Self {
        Self {
            generation: 0,
            phase: RuntimePhase::Stopped,
            local_host: ServiceSnapshot::stopped(),
            narrative_bridge: ServiceSnapshot::stopped(),
            last_error: None,
        }
    }
}
