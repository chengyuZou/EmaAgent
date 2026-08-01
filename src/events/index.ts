import type { AgentRunEvent, AgentTurnEvent } from '@ema-agent/agent';
import type { CharacterEvent } from '@ema-agent/characters';
import type { ContextEvent } from '@ema-agent/context';
import type { EmotionStreamEvent } from '@ema-agent/emotion';
import type { KnowledgeEvent } from '@ema-agent/knowledge';
import type {
  MemoryBackgroundEvent,
  MemoryRecallEvent,
} from '@ema-agent/memory';
import type { NarrativeEvent } from '@ema-agent/narrative';
import type { PermissionStreamEvent } from '@ema-agent/permission';
import type { SystemEvent } from '@ema-agent/system';
import type { TaskEvent } from '@ema-agent/tasks';
import type {
  BackgroundProcessEvent,
  ToolStreamEvent,
} from '@ema-agent/tools';
import type { TtsEvent } from '@ema-agent/tts';
import type { TurnEvent } from '@ema-agent/turn';

/**
 * 一次 Turn SSE 可能承载的事件。每个成员仍由对应业务模块定义，
 * events 只冻结跨模块组合，禁止在这里增加业务字段。
 */
export type TurnStreamEvent =
  | TurnEvent
  | AgentTurnEvent
  | AgentRunEvent
  | ToolStreamEvent
  | PermissionStreamEvent
  | EmotionStreamEvent
  | TtsEvent
  | NarrativeEvent
  | MemoryRecallEvent
  | TaskEvent
  | ContextEvent;

/** Session 范围的持久工作项和执行投影。 */
export type SessionEvent =
  | TaskEvent
  | AgentRunEvent;

/** 不从属于某个 Turn 的应用后台事件。 */
export type AppEvent =
  | MemoryBackgroundEvent
  | KnowledgeEvent
  | CharacterEvent
  | BackgroundProcessEvent
  | SystemEvent;

/** 跨端解码器在协议入口使用的完整联合，不能作为业务生产者的 emit 类型。 */
export type ClientEvent = TurnStreamEvent | SessionEvent | AppEvent;
