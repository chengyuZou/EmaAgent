/**
 * Agent Workspace 的产物与变动差异协议 (V1 正式版)。
 *
 * Artifact 既可以是前端通过解析带注释的 Markdown 块提取出来的视图展现 (例如独立代码块、架构图)，
 * 也可以是底层 Agent 调用工具系统经过持久化生成的实体 (例如产生的安全补丁、执行后生成的数据集)。
 */

/** Workspace 中可管理的产物类型。 */
export type ArtifactKind =
    | "code"          // 根据 Markdown 解析出的独立代码块
    | "table"         // 结构化表格数据
    | "mermaid"       // Mermaid 流程图或架构图
    | "math"          // 复杂长段数学公式 (KaTeX/MathJax)
    | "html_report"   // 独立 HTML 视图
    | "chart"         // 渲染图表
    | "image"         // 图像
    // ========== 带有本地副作用的类型 ==========
    | "file"          // 代表本地真实文件将被覆盖/新建
    | "patch"         // 针对单个/多个本地文件的统一差异补丁 (Unified Diff)
    | "dataset"       // 执行所生成的存盘数据集
    | "notebook"      // Jupter 样式的笔记容器
    | "log";          // 极其冗长的流水线排错日志

/** 产物当前的生命周期状态。 */
export type ArtifactStatus =
    | "draft"       // LLM 正在流式生成中，提供骨架加载态
    | "ready"       // 产物在内存里生成完毕，等待用户查阅或采纳
    | "applied"     // (仅本地副作用类) 用户已点击无误，且修改成功落盘
    | "rejected"    // 用户拒绝了这个产物的应用建议或手动废除了它
    | "superseded"  // LLM 在接下来的对话中生成了新的修正版，该旧版本自动作废
    | "failed";     // 生成失败，或是应用到本地系统时遇到权限/合并冲突

// ==========================================
// 1. 结构化挂载数据
// ==========================================

export interface FileDiffSummary {
    /** 相对工作区环境的路径。 */
    path: string;
    /** * 单个文件的语言标识（用于多文件 Patch 时的高亮）。
     * 允许为空，遇空时前端或 Agent 可根据 path 的后缀名（如 .ts, .py）自动推断兜底。
     * @example 'typescript'
     */
    language?: string;
    /** 变更类型。 */
    changeType: "added" | "modified" | "deleted" | "renamed";
    /** 原路径（如果是重命名）。 */
    oldPath?: string;
    
    /** * 【精修优化】：Hash 下移至文件级。
     * 用于精确控制单个文件的乐观锁与冲突合并。 
     */
    baseHash?: string;
    headHash?: string;

    /** 代码增删行数统计，用于在列表高亮风险热力。 */
    stats: {
        additions: number;
        deletions: number;
    };
}

export interface DiffMeta {
    /** 本次补丁涉及的所有独立文件变动详情。 */
    files: FileDiffSummary[];
    /** * (可选) 整个工作区的整体提交 Hash 
     * 仅当系统完全接管 git 版本控制时使用。
     */
    commitHash?: string; 
}

/** * 专门绑定杂项特征参数的接口
 * 当我们在列表只展现摘要时，前端也可以依据此字段来预先画出代码语言、更改行数热力图。
 */
export interface ArtifactParams {
    /** * 顶层语言体系。
     * （仅用于 kind: 'code' 等单体不可切分产物，对于多文件的 diff，请查阅 diff.files 里的 language）
     * @example 'typescript' 
     */
    language?: string;
    /** 挂载的变更结构元数据，有了它即使不读取全量 diff 也能画出文件更改树。 */
    diff?: DiffMeta;
    
    /** * 【精修优化】：收拢未知属性。
     * 将其他根据底层环境可自由追加的解析属性，统一收口至 extra。
     * 防止未来添加官方字段时（如新增 'tokenCount'）与第三方插件的自定义字段发生冲突。
     */
    extra?: Record<string, unknown>;
}


// ==========================================
// 2. 列表摘要层 (聊天流里的轻量级卡片)
// ==========================================
export interface ArtifactSummary {
    /** 产物的全局唯一 ID。 */
    id: string;
    /** 追溯该产物资生的整个对话会话跟踪 (全链路)。 */
    traceId?: string;
    /** 这个产物是从上报哪一次确切 API Request 时诞生的。 */
    requestId: string;

    /** 核心类型，UI 据此派遣专用右侧面板渲染器。 */
    kind: ArtifactKind;
    /** 给用户看的友好直白名称。 @example "重新设计 Router 错误拦截" */
    title: string;
    /** MIME 类型辨识。 */
    mime: string;

    /**
     * 一个 patch 和改动往往涉及重构多个文件。
     * 当类型是文件落盘、diff 等有本地依赖性时使用。
     */
    targetPaths?: string[];

    /** 用于存储行数统计、代码高亮语言类型等无需依赖庞大 Body 的数据。 */
    params?: ArtifactParams;

    /** 该数据的状态情况（进行中、已落地、由于版本被覆盖废弃）。 */
    status: ArtifactStatus;
    createdAt: number;
    // 供后续进行悲观乐观锁更新使用的毫秒戳。
    updatedAt: number;
}

// ==========================================
// 3. 内容详情载荷 (右侧面板的完全渲染与应用)
// ==========================================
export interface ArtifactDetail {
    /** 对应继承的数据。 */
    summary: ArtifactSummary;

    /**
     * 产物的最原始/序列化的文本内容。
     * 大量的源码、Unified Diff(补丁修补文本)、MathJax 字符都在这。
     */
    content: string;

    /**
     * 【修复地雷1】：本地环境持久化与 IPC / WebSocket 传输，禁止使用 ArrayBuffer 对象。
     * 若必须包含二进制图像生成流，此处必须是 `data:image/png;base64,...` 的 Base64 DataURL 或本地绝对可访问的磁盘句柄地址。
     */
    binaryBase64?: string;

    /** 当前详情内容数据的纯文本哈希签名，防止重播或网络延时串流应用导致数据过期。 */
    contentHash?: string;
}