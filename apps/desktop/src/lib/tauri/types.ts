import type { PermissionRequiredEvent } from '@ema-agent/permission';
import type { AskUserRequiredEvent } from '@ema-agent/tools';
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

export type DecisionRequiredEvent = PermissionRequiredEvent | AskUserRequiredEvent;

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
