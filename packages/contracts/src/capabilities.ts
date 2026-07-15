// ── 发布特性开关(wire)─────────────────────────────────────────────────────────
//
// V1 发布特性开关,经 GET /api/system/capabilities 暴露给前端。
// 前端据此决定是否显示 Artifact 等未完成功能的入口(fail-closed:
// 未加载/请求失败/字段缺失时一律视为 false)。

/** V1 发布特性开关。artifacts=false 表示 Artifact 在 V1 禁用(V1.5 预留)。 */
export interface ReleaseFeaturesWire {
  readonly artifacts: boolean;
}

/** GET /api/system/capabilities 的响应体。前端据 features 决定入口可见性。 */
export interface AppCapabilitiesWire {
  readonly release: 'v1';
  readonly features: ReleaseFeaturesWire;
}

/**
 * 会话导入时的结构化警告。V1 下 Artifact 等未启用特性的备份数据会被忽略,
 * 后端在此告知前端"导入了会话但跳过了哪些内容",前端据此提示用户。
 */
export interface ImportWarningWire {
  readonly code: 'unsupported_feature';
  readonly feature: 'artifacts';
  readonly message: string;
}
