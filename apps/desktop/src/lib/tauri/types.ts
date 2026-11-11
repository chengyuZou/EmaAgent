import type { PermissionUserAction } from '@ema-agent/permission';
import type { PendingInteraction } from '@ema-agent/turn';
import type { EventDisplayTable } from '../../api/settings.js';

export interface SelectPathsOptions {
  readonly title?: string;
  readonly directory?: boolean;
  readonly multiple?: boolean;
  readonly filters?: readonly {
    readonly name: string;
    readonly extensions: readonly string[];
  }[];
}

export type PetPointerEvent =
  | { readonly type: 'position'; readonly clientX: number; readonly clientY: number; readonly inside: boolean }
  | { readonly type: 'error'; readonly message: string };

export interface DesktopSettingsPayload {
  readonly permissionTimeoutMs: number | null;
  readonly eventDisplay: EventDisplayTable | null;
}

export interface InteractionNotification {
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly kind: PendingInteraction['kind'];
  readonly sessionApprovalDescription?: string;
  readonly title: string;
  readonly body: string;
}

export interface InteractionNotificationUpdate {
  /** null means main is not displaying a Session, including while Settings is open. */
  readonly viewedSessionId: string | null;
  readonly notifications: readonly InteractionNotification[];
}

export type DesktopNotificationAction =
  | { readonly action: 'openSession'; readonly sessionId: string }
  | {
      readonly action: PermissionUserAction;
      readonly sessionId: string;
      readonly turnId: string;
      readonly toolCallId: string;
    };

export interface SessionCompletionNotification {
  readonly id: string;
  readonly sessionId: string;
  readonly title: string;
  readonly kind: 'turnCompleted' | 'turnFailed' | 'compactCompleted' | 'compactFailed';
  readonly viewedSessionId: string | null;
}

export type TerminalEvent =
  | { readonly type: 'output'; readonly data: readonly number[] }
  | { readonly type: 'exit'; readonly exitCode: number | null };

export interface OpenTerminalInput {
  readonly terminalId: string;
  readonly sessionId: string;
  readonly cwd?: string;
  // kind 决定启动参数(如 PowerShell 补 -NoLogo), path 是 Shell 可执行文件的实际路径.
  readonly shell?: { readonly kind: string; readonly path: string };
  readonly columns: number;
  readonly rows: number;
  readonly onEvent: (event: TerminalEvent) => void;
}

export interface BrowserBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type BrowserEvent =
  | { readonly type: 'loading'; readonly browserId: string; readonly loading: boolean }
  | { readonly type: 'locationChanged'; readonly browserId: string; readonly url: string }
  | { readonly type: 'titleChanged'; readonly browserId: string; readonly title: string };

export type Live2dPreviewCommand =
  | { readonly type: 'expression'; readonly expression: string }
  | { readonly type: 'motion'; readonly group: string; readonly index: number }
  | {
      readonly type: 'placement';
      readonly stageScale: number;
      readonly stageOffsetX: number;
      readonly stageOffsetY: number;
    };

export type FileDragEvent =
  | { readonly type: 'leave' }
  | { readonly type: 'enter' | 'over'; readonly x: number; readonly y: number }
  | { readonly type: 'drop'; readonly x: number; readonly y: number; readonly paths: readonly string[] };

/** revision 由 main 递增, 字幕视图用它忽略晚到的旧消息. */
export type CaptionState =
  | { readonly kind: 'hidden'; readonly revision: number }
  | {
      readonly kind: 'text';
      readonly revision: number;
      readonly sessionId: string;
      readonly turnId: string;
      readonly text: string;
    }
  | {
      readonly kind: 'speech';
      readonly revision: number;
      readonly sessionId: string;
      readonly turnId: string;
      readonly audioId: string;
      readonly segmentIndex: number;
      readonly text: string;
      /** false 表示播放器暂时缓冲, 保留当前段并暂停显字动画. */
      readonly playing: boolean;
    };

export interface StageVoiceSession {
  readonly sessionId: string;
  readonly title: string;
}

export type StageVoiceContextChange =
  | { readonly type: 'sessions'; readonly sessions: readonly StageVoiceSession[] }
  | { readonly type: 'viewed-session'; readonly sessionId: string | null }
  | { readonly type: 'playback'; readonly isPlaying: boolean };

export interface StageVoiceSendRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly text: string;
}

export type StageVoiceSendResult = { readonly requestId: string } & (
  | { readonly status: 'accepted' }
  // 仅明确未接收时还原草稿; 断线后 Server 可能已接收, 不能引导重复发送.
  | { readonly status: 'rejected' | 'unknown'; readonly message: string }
);

