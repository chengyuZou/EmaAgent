export interface AskUserQuestionSpec {
  /** 回答键(q0/q1...);模型看到的最终答案以问题文本为键,Tool 负责映射. */
  id: string;
  question: string;
  header: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

/** 工具提交问题并等待回答. Turn 通过 SessionInteractionQueue 排队, 发布事件, 处理超时和取消. */
export type AskUser = (
  toolCallId: string,
  specs: readonly AskUserQuestionSpec[],
  /** 单调用级取消:Turn abort 与兄弟取消都经它中断等待;用户取消卡片走队列终态. */
  signal: AbortSignal,
) => Promise<{ answers: Record<string, string> }>;

export type AskUserEvent =
  | {
      type: 'ask_user_required';
      sessionId: string;
      turnId: string;
      // 问询归属于发起它的 ToolCall, 不另建一份请求身份.
      toolCallId: string;
      questions: AskUserQuestionSpec[];
    }
  | {
      type: 'ask_user_resolved';
      sessionId: string;
      toolCallId: string;
      answers: Record<string, string>;
    };

export type AskUserRequiredEvent = Extract<AskUserEvent, { type: 'ask_user_required' }>;

/** 已经进入 Session 交互队列, 尚未回答或取消的一次 AskUser 请求. */
export interface PendingAskUserRequest {
  // 入队时的 Unix 时间, 单位毫秒. 排队本身不计入用户回答的超时时间.
  createdAt: number;
  request: AskUserRequiredEvent;
}
