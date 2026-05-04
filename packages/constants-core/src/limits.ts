/**
 * 系统限额常量 — 超时、字节限制、token 预算、分页默认值。
 *
 * 所有跨包共用的阈值集中于此，避免各包各自定义导致不一致。
 */

// ═══════════════════════════════════════════════════════════════
// 超时（毫秒）
// ═══════════════════════════════════════════════════════════════

/** Shell 命令默认超时。 */
export const SHELL_TIMEOUT_MS = 30_000

/** Python 脚本默认超时。 */
export const PYTHON_TIMEOUT_MS = 30_000

/** HTTP 请求默认超时（LLM API 调用）。 */
export const HTTP_REQUEST_TIMEOUT_MS = 60_000

/** STT 录音静音超时——用户停止说话后等待多久结束录音。 */
export const STT_SILENCE_TIMEOUT_MS = 2_000

/** Turn 并发锁默认超时——获取锁的最长等待时间。 */
export const TURN_LOCK_TIMEOUT_MS = 30_000

/** Provider 健康检查超时。 */
export const PROVIDER_HEALTH_CHECK_TIMEOUT_MS = 10_000

// ═══════════════════════════════════════════════════════════════
// 字节/大小限制
// ═══════════════════════════════════════════════════════════════

/** Shell/Python 命令输出截断上限（字节）。 */
export const COMMAND_MAX_OUTPUT_BYTES = 256_000

/** 单次文件读取上限（字节）。 */
export const FILE_READ_MAX_BYTES = 256_000

/** 文件搜索最大文件数。 */
export const MAX_SEARCH_FILES = 500

/** LLM 错误响应截断长度（字符）。 */
export const ERROR_TEXT_TRUNCATE = 300

/** LLM 错误原始响应截断长度（字符）。 */
export const ERROR_RAW_TRUNCATE = 500

/** 附件单次上传上限(10 MB)。 */
export const ATTACHMENT_MAX_BYTES = 10_000_000

// ═══════════════════════════════════════════════════════════════
// Token 预算
// ═══════════════════════════════════════════════════════════════

/** 默认上下文预算（tokens）。 */
export const DEFAULT_CONTEXT_BUDGET = 8_000

/** 保留给模型输出的 token 比例（占上下文预算的比例）。 */
export const OUTPUT_TOKEN_RESERVE_RATIO = 0.25

/** 保留输出的 token 上限。 */
export const OUTPUT_TOKEN_RESERVE_CAP = 2_048

/** 文本 → token 估算倍率（chars / token）。 */
export const CHARS_PER_TOKEN_ESTIMATE = 4

// ═══════════════════════════════════════════════════════════════
// 分页
// ═══════════════════════════════════════════════════════════════

/** 近期消息默认页大小。 */
export const RECENT_MESSAGES_PAGE_SIZE = 12

/** Session 列表默认页大小。 */
export const SESSION_LIST_PAGE_SIZE = 20

/** Memory fact 召回默认条数。 */
export const MEMORY_RECALL_LIMIT = 8

// ═══════════════════════════════════════════════════════════════
// 标题
// ═══════════════════════════════════════════════════════════════

/** 会话标题最大长度（字符）。 */
export const SESSION_TITLE_MAX_LENGTH = 24

/** 标题截断后缀。 */
export const TITLE_TRUNCATION_SUFFIX = "..."

// ═══════════════════════════════════════════════════════════════
// 本地开发 / 模拟
// ═══════════════════════════════════════════════════════════════

/** 本地模拟流式输出的分块大小（字符）。 */
export const LOCAL_DEV_CHUNK_SIZE = 12

/** 本地模拟流式输出的分块间隔（毫秒）。 */
export const LOCAL_DEV_CHUNK_DELAY_MS = 12

/** 本地模拟标题截断长度。 */
export const LOCAL_DEV_TITLE_TRUNCATE = 18

// ═══════════════════════════════════════════════════════════════
// 内存
// ═══════════════════════════════════════════════════════════════

/** 默认 fact 置信度。 */
export const DEFAULT_FACT_CONFIDENCE = 0.8

/** 滚动摘要块的上下文优先级。 */
export const ROLLING_SUMMARY_PRIORITY = 80

/** 用户画像块的上下文优先级。 */
export const USER_PROFILE_PRIORITY = 60

/** 近期消息块的上下文优先级。 */
export const RECENT_MESSAGES_PRIORITY = 60
