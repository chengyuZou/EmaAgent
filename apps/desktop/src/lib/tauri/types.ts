import type { PermissionResponse } from '@ema-agent/permission';
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
  readonly title: string;
  readonly body: string;
}

export interface InteractionNotificationUpdate {
  /** null means main is not displaying a Session, including while Settings is open. */
  readonly viewedSessionId: string | null;
  readonly notifications: readonly InteractionNotification[];
}

export interface InteractionNotificationAction {
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly action: 'openSession' | PermissionResponse['action'];
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
