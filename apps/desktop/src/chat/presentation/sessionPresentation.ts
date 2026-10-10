import { tauriBridge } from '../../lib/tauri-bridge.js';

interface PresentationOwner {
  readonly sessionId: string;
  readonly turnId: string;
  /** 包含等待音频和加载 URL; 正文结束时不能截断仍在播放的语音. */
  playbackActive: boolean;
}

/** 50ms 内合并 owner 的文字 delta, 避免 SpeechBubble 为每个 token 跨 WebView 重绘. */
const DIALOGUE_FLUSH_MS = 50;

let owner: PresentationOwner | null = null;
let pendingText = '';
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function owns(sessionId: string, turnId: string): boolean {
  return owner?.sessionId === sessionId && owner.turnId === turnId;
}

function discardPendingText(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  pendingText = '';
}

function flushPendingText(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (!owner || pendingText.length === 0) return;
  const text = pendingText;
  pendingText = '';
  void tauriBridge.publishDialogueDelta(owner.sessionId, owner.turnId, text);
}

function releaseOwner(): void {
  const previous = owner;
  if (!previous) return;
  owner = null;
  discardPendingText();
  void tauriBridge.publishDialogueEnded(previous.sessionId, previous.turnId);
}

/** 同一时刻只有一轮驱动桌宠的文字, 情绪, 动作和口型. 不保存等待接管的 Turn. */
export const sessionPresentation = {
  /** 仅在 Turn 开始或用户主动重播时申请; 失败的 Turn 不排队, 也不在以后补播. */
  claim(sessionId: string, turnId: string): boolean {
    if (owner) return false;
    owner = { sessionId, turnId, playbackActive: false };
    return true;
  },

  /** 取得 owner 后开始本地播放流程, 包括尚未收到第一块音频的等待时间. */
  playbackStarted(sessionId: string, turnId: string): void {
    if (owns(sessionId, turnId)) owner!.playbackActive = true;
  },

  text(sessionId: string, turnId: string, delta: string): void {
    if (!owns(sessionId, turnId) || !delta) return;
    pendingText += delta;
    flushTimer ??= setTimeout(flushPendingText, DIALOGUE_FLUSH_MS);
  },

  emotion(sessionId: string, turnId: string, emotion: string): void {
    if (owns(sessionId, turnId)) void tauriBridge.publishStageEmotion(emotion);
  },

  motion(sessionId: string, turnId: string, motion: string): void {
    if (owns(sessionId, turnId)) void tauriBridge.publishStageMotion(motion);
  },

  /** 没有本地语音时随正文结束释放; 有语音时等待媒体实际结束, 不看 TTS 按钮的当前值. */
  finishTurn(sessionId: string, turnId: string): void {
    if (!owns(sessionId, turnId) || owner!.playbackActive) return;
    // 纯文字 Turn 结束前送出最后一段合并正文, 否则不足 50ms 的部分会随 owner 一起丢弃.
    flushPendingText();
    releaseOwner();
  },

  /** 媒体结束, 停止或失败立即释放, 即使这一轮文字还在生成. */
  playbackEnded(sessionId: string, turnId: string): void {
    if (owns(sessionId, turnId)) releaseOwner();
  },

  /** Session 已归档或删除时只清理它的表现; 本地音频由播放模块单独停止. */
  cancelSession(sessionId: string): void {
    if (owner?.sessionId === sessionId) releaseOwner();
  },

  owns,
};
