/**
 * Agent Workspace 的产物与 Diff 协议。
 *
 * 任何文件、图表、报告、patch 都不应该只塞进聊天正文，而应该作为 artifact
 * 进入 WorkspacePane，由前端决定预览、编辑、diff、apply 或 reject。
 */

/** Workspace 中可管理的产物类型。 
 * @TODO 加上code table mermaid math等非文件类型的产物种类。
*/
export type ArtifactKind =
  | "file"
  | "patch"
  | "diff"
  | "chart"
  | "image"
  | "html_report"
  | "notebook"
  | "dataset"
  | "log";

/** 产物当前生命周期状态。 */
export type ArtifactStatus = "draft" | "ready" | "applied" | "rejected" | "superseded" | "failed";

/** Workspace 列表中展示的轻量摘要。 */
export interface ArtifactSummary {
  /** 产物 ID。 */
  id: string;
  /** 产物来自哪一轮 turn。 */
  requestId: string;
  /** 产物类型。 */
  kind: ArtifactKind;
  /** 展示标题。 */
  title: string;
  /** MIME 类型，前端据此选择预览器。 */
  mime: string;
  /** 内容懒加载引用，可以是本地相对路径、blob key 或 DB payload key。 */
  payloadRef: string;
  /** 原始文件路径，只有 patch/diff/file 需要。 */
  targetPath?: string;
  /** 当前状态。 */
  status: ArtifactStatus;
  /** 创建时间戳。 */
  createdAt: number;
  /** 更新时间戳。 */
  updatedAt: number;
}

/** 单个文件的 diff 摘要。 */
export interface FileDiffSummary {
  /** 相对工作区路径。 */
  path: string;
  /** 变更类型。 */
  changeType: "added" | "modified" | "deleted" | "renamed";
  /** 旧路径，rename 时使用。 */
  oldPath?: string;
  /** 统计信息，前端用于列表和风险提示。 */
  stats: {
    additions: number;
    deletions: number;
  };
}

/** diff_ready 事件中传输的结构化 diff 摘要。 */
export interface DiffSummary {
  /** 对应 artifact。 */
  artifactId: string;
  /** 本次 diff 基于的文件 hash，apply 前必须校验。 */
  baseHash?: string;
  /** 应用后预期 hash。 */
  headHash?: string;
  /** 涉及文件列表。 */
  files: FileDiffSummary[];
  /** 原始 unified diff 的懒加载引用。 */
  patchRef?: string;
}

/**
 * 兼容旧代码的 ArtifactMeta。
 *
 * 新代码应优先使用 ArtifactSummary；这个类型保留给早期 UI 与工具返回值迁移。
 */
export interface ArtifactMeta {
  kind: "tool_image" | "chart" | "report_file" | "audio" | "video";
  title: string;
  url: string;
  mime?: string;
  sourceTool?: string;
}
