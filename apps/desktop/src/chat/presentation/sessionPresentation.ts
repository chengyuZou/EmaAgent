import { tauriBridge } from '../../lib/tauri-bridge.js';

interface PresentationClaim {
  readonly sessionId: string;
  readonly turnId: string;
  /** Speech 生成句子前等待这个 Promise, 防止 waiting Turn 提前发声和驱动嘴型. */
  readonly activated: Promise<void>;
  /** Claim 成为 FIFO 队首时结束 activated, 此后这一轮才可以开始实时 Speech. */
  activate(): void;
  /** waiting Turn 提前结束或 Session 被移除时拒绝 activated, 让尚未开始的 Speech 直接退出. */
  cancelActivation(reason: Error): void;
  /** 取消这一轮已经建立的 Server Speech 连接和本地播放, Session 取消与 waiting 失效都会调用. */
  readonly cancelSpeech: () => void;
  /** 收到 Turn terminal 后为 true. 它不代表本地音频已经播放完. */
  turnTerminal: boolean;
  /** TTS 关闭, 或本地播放已经结束, 取消, 失败后为 true. 与 turnTerminal 同时满足才能 release. */
  speechSettled: boolean;
  /** waiting 期间只保留最后一个 Emotion. 获得 owner 时发送一次, 不重放中间变化. */
  pendingEmotion?: string;
}

/** 50ms 内合并 owner 的文字 delta, 避免 SpeechBubble 为每个 token 跨 WebView 重绘. */
const DIALOGUE_FLUSH_MS = 50;

// Map 保持插入顺序: 第一项是当前 owner, 后面的 Claim 按 turn_started 顺序等待.
// turnId 同时提供 O(1) 定位, 不需要为 FIFO 再维护数组索引.
const claims = new Map<string, PresentationClaim>();
// 这里只保存当前 owner 尚未发送给 SpeechBubble 的短文本. waiting Turn 的文字不会进入缓冲区.
let pendingText = '';
// owner 交接时用它识别旧文本, 先丢弃旧 owner 的尾部, 再接收新 owner 的 delta.
let pendingTurnId: string | null = null;
// timer 只覆盖上面的全局短缓冲. flush, owner 交接和 Session 取消都会清掉它.
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function findClaim(sessionId: string, turnId: string): PresentationClaim | undefined {
  const claim = claims.get(turnId);
  return claim?.sessionId === sessionId ? claim : undefined;
}

function ownerClaim(): PresentationClaim | undefined {
  return claims.values().next().value as PresentationClaim | undefined;
}

function isOwner(claim: PresentationClaim): boolean {
  return ownerClaim() === claim;
}

function promoteFirst(): void {
  const next = ownerClaim();
  if (!next) return;
  next.activate();
  if (next.pendingEmotion) {
    void tauriBridge.publishStageEmotion(next.pendingEmotion);
    next.pendingEmotion = undefined;
  }
}

/** owner 交接或取消时丢弃尚未显示的旧文本, 不能把它发送到新 Turn 的气泡里. */
function discardPendingText(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  pendingText = '';
  pendingTurnId = null;
}

/** 只把仍属于当前 owner 的文本发给 Stage; 50ms 内已经失去 owner 的文本直接丢弃. */
function flushPendingText(): void {
  flushTimer = null;
  const owner = ownerClaim();
  if (!owner || owner.turnId !== pendingTurnId || pendingText.length === 0) {
    pendingText = '';
    pendingTurnId = null;
    return;
  }

  const text = pendingText;
  pendingText = '';
  pendingTurnId = null;
  void tauriBridge.publishDialogueDelta(owner.sessionId, owner.turnId, text);
}

function queueOwnerText(claim: PresentationClaim, delta: string): void {
  if (!delta) return;
  if (pendingTurnId !== null && pendingTurnId !== claim.turnId) discardPendingText();
  pendingTurnId = claim.turnId;
  pendingText += delta;
  flushTimer ??= setTimeout(flushPendingText, DIALOGUE_FLUSH_MS);
}

function releaseOwnerIfSettled(claim: PresentationClaim): void {
  if (!isOwner(claim) || !claim.turnTerminal || !claim.speechSettled) return;
  claims.delete(claim.turnId);
  discardPendingText();
  void tauriBridge.publishDialogueEnded(claim.sessionId, claim.turnId);
  promoteFirst();
}

/** Session Turn Event 与实时 Speech 共用的唯一 Presentation Claim 队列. */
export const sessionPresentation = {
  /** Turn 开始时申请唯一桌宠表现权. 第一项立即激活, 后续 Claim 按插入顺序等待. */
  claim(
    sessionId: string,
    turnId: string,
    /** 前端页面里 TTS 是否启用的按钮 */
    ttsEnabled: boolean,
    /** 生成TTS期间点击取消播放按钮 */
    cancelSpeech: () => void,
  ): void {
    if (claims.has(turnId)) return;
    let activate!: () => void;
    let rejectActivation!: (reason: Error) => void;
    const activated = new Promise<void>((resolve, reject) => {
      activate = resolve;
      rejectActivation = reject;
    });
    // 等待中的 Turn 被取消时这个 Promise 会被拒绝. 预先挂 catch
    // 避免还没有音频句子等待它时产生浏览器的 unhandled rejection.
    void activated.catch(() => {});
    const claim: PresentationClaim = {
      sessionId,
      turnId,
      activated,
      activate,
      cancelActivation: rejectActivation,
      cancelSpeech,
      turnTerminal: false,
      // TTS 关闭时仍需要 Claim 驱动对话气泡, 情绪和动作,
      // 但没有本地音频需要等待. Turn 进入终态后可以直接释放.
      speechSettled: !ttsEnabled,
    };
    claims.set(turnId, claim);
    if (claims.size === 1) promoteFirst();
  },

  /** 实时 Speech 在生成或播放前等待当前 Turn 真正取得 Presentation owner. */
  whenActive(sessionId: string, turnId: string): Promise<void> {
    const claim = findClaim(sessionId, turnId);
    return claim
      ? claim.activated
      : Promise.reject(new Error('Presentation claim is no longer active'));
  },

  /** 只接收 owner 的正文 delta; waiting Turn 的正文不保存, 也不会在接管后补播. */
  text(sessionId: string, turnId: string, delta: string): void {
    const claim = findClaim(sessionId, turnId);
    if (claim && isOwner(claim)) queueOwnerText(claim, delta);
  },

  /** owner 的 Emotion 立即转发; waiting Claim 只保留最后一次变化. */
  emotion(sessionId: string, turnId: string, emotion: string): void {
    const claim = findClaim(sessionId, turnId);
    if (!claim) return;
    if (isOwner(claim)) {
      void tauriBridge.publishStageEmotion(emotion);
    } else {
      claim.pendingEmotion = emotion;
    }
  },

  /** Motion 是一次性动作. waiting 期间不保存, 避免接管时补播已经过时的动作. */
  motion(sessionId: string, turnId: string, motion: string): void {
    const claim = findClaim(sessionId, turnId);
    if (claim && isOwner(claim)) void tauriBridge.publishStageMotion(motion);
  },

  /** Turn 已经终态时停止接收新表现; owner 仍可能等待最后几句本地音频播放完. */
  finishTurn(sessionId: string, turnId: string): void {
    const claim = findClaim(sessionId, turnId);
    if (!claim) return;
    claim.turnTerminal = true;
    if (!isOwner(claim)) {
      // 等待队列中的 Session 已经结束时直接移除. 先移出队列再取消语音,
      // 即使这时前一个 owner 同步释放, 也不会把已结束的 Session 提升成 owner.
      claims.delete(claim.turnId);
      claim.cancelActivation(new Error('Turn ended before presentation ownership'));
      claim.cancelSpeech();
      return;
    }
    releaseOwnerIfSettled(claim);
  },

  /** 本地音频实际结束, 取消或失败后结算 Speech, 不是 Server 停止生成音频时调用. */
  speechSettled(sessionId: string, turnId: string): void {
    const claim = findClaim(sessionId, turnId);
    if (!claim) return;
    claim.speechSettled = true;
    releaseOwnerIfSettled(claim);
  },

  /** Session 关闭, 归档或删除时移除它的全部 Claim, 并把 owner 交给仍有效的 FIFO 队首. */
  cancelSession(sessionId: string): void {
    const owner = ownerClaim();
    const removed = [...claims.values()].filter(claim => claim.sessionId === sessionId);
    if (removed.length === 0) return;
    const ownerRemoved = owner !== undefined && removed.includes(owner);
    for (const claim of removed) {
      claims.delete(claim.turnId);
      claim.cancelActivation(new Error('Session presentation cancelled'));
      claim.cancelSpeech();
    }
    if (ownerRemoved && owner) {
      discardPendingText();
      void tauriBridge.publishDialogueEnded(owner.sessionId, owner.turnId);
      promoteFirst();
    }
  },

  /** Speech 和 Stage 转发用它确认某个 Turn 当前是否拥有唯一表现权. */
  owns(sessionId: string, turnId: string): boolean {
    const claim = findClaim(sessionId, turnId);
    return claim !== undefined && isOwner(claim);
  },
};
