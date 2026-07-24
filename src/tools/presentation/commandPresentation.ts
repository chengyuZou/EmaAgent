// 描述命令执行后可供界面信任的命令、目录和终止状态。
export interface CommandPresentation {
  readonly kind: 'command';
  readonly command: string;
  readonly workingDirectory: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly truncated: boolean;
}

export interface CreateCommandPresentationInput {
  readonly command: string;
  readonly workingDirectory: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly truncated: boolean;
}

export function createCommandPresentation(
  input: CreateCommandPresentationInput,
): CommandPresentation {
  return { ...input, kind: 'command' };
}
