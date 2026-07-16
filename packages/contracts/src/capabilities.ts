// 这里放系统能力接口返回给前端的发布开关和沙箱安全状态。

/** V1 发布开关；false 表示对应功能暂不向用户开放。 */
export interface ReleaseFeaturesWire {
  readonly artifacts: boolean;
}

/** GET /api/system/capabilities 的响应。 */
export interface AppCapabilitiesWire {
  readonly release: 'v1';
  readonly features: ReleaseFeaturesWire;
}

/** 当前机器上 Shell 和本地 MCP 进程实际受到的保护。 */
export interface SandboxStatusWire {
  readonly backend: 'bubblewrap' | 'sandbox-exec' | 'app-layer';
  readonly isolation: 'os' | 'application-only';
  readonly shellExecution: 'isolated' | 'disabled' | 'unsafe-override';
  readonly localMcpStdio: 'isolated' | 'disabled' | 'unsafe-override';
  readonly warning?: string;
}

/** 导入备份时跳过尚未发布功能所产生的提示。 */
export interface ImportWarningWire {
  readonly code: 'unsupported_feature';
  readonly feature: 'artifacts';
  readonly message: string;
}
