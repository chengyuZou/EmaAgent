export { ErrorCode, EmaError, isEmaError } from "./errors.js";
export type { ErrorCodeType } from "./errors.js";

export {
  AGENT_MAX_STEPS,
  TOOL_CONFIRM_TIMEOUT_MS,
  MAX_PARALLEL_READONLY_TOOLS,
  LLM_STEP_TIMEOUT_MS,
  TOOL_STEP_TIMEOUT_MS,
} from "./agent.js";

export {
  WORKING_MEMORY_WINDOW_SIZE,
  MEMORY_RECALL_TOPK,
  MEMORY_CONTEXT_BUDGET_CHARS,
} from "./memory.js";

export {
  LIVE2D_DEFAULT_FPS,
  LIVE2D_MOUTH_SYNC_GAIN,
  LIVE2D_IDLE_MOTION_INTERVAL_MS,
} from "./live2d.js";

export { BINARY_EXTENSIONS, hasBinaryExtension, isBinaryContent } from "./files.js";
