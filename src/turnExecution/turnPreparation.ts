// 把一次根 Turn 的附件、模型能力、Prompt 与工作区事实冻结成纯值 TurnInput。

import type {
  Attachment,
  AttachmentInput,
  AttachmentStorePort,
} from '@ema-agent/attachment';
import type { SessionId, TurnId } from '@ema-agent/ids';
import {
  llmProviderErrorCode,
  type LlmContentPart,
  type ThinkingMode,
} from '@ema-agent/llm';
import type {
  ModelCapabilityResolver,
  ModelCapabilitySnapshot,
} from '@ema-agent/provider';
import {
  buildPromptSnapshot,
  type PromptBuildRequest,
  type PromptSlotContribution,
} from '@ema-agent/prompts';
import type {
  AttachmentReferenceBlock,
  MessageBlocks,
  SessionStore,
} from '@ema-agent/session';
import type {
  ExecutionProfile,
  KbAssetScope,
  NarrativePolicy,
  RequestDegradationNotice,
} from '@ema-agent/turn';
import { TurnPreparationError } from './errors.js';
import {
  prepareImagesForModel,
  replaceImageParts,
  type MediaCompatibilityServices,
} from './mediaCompatibility.js';
import type {
  TurnInput,
  TurnModelSnapshot,
  TurnPreparationContext,
  TurnSettingsSnapshot,
} from './types.js';

const DEFAULT_MODEL_CONTEXT_WINDOW = 200_000;

export interface TurnPreparationRequest {
  readonly executionProfile: ExecutionProfile;
  readonly narrativePolicy: NarrativePolicy;
  readonly userInput: string;
  readonly contentParts?: readonly LlmContentPart[];
  readonly attachmentInputs?: readonly AttachmentInput[];
  readonly providerId?: string;
  readonly model?: string;
  readonly kbIds?: readonly string[];
  readonly kbAssetScopes?: readonly KbAssetScope[];
  readonly thinking?: ThinkingMode;
}

export interface TurnInputPreparerDeps {
  readonly session: Pick<SessionStore, 'getSession'>;
  readonly attachments: Pick<AttachmentStorePort, 'addAll' | 'resolveForPrompt'>;
  readonly modelCapabilities: ModelCapabilityResolver;
  readonly contextWindowFor: (
    providerId: string,
    model: string,
  ) => number | null | undefined;
  readonly activeCharacter: () => PromptBuildRequest['activeCharacter'];
  readonly extensionPromptContributions?: (
    executionProfile: ExecutionProfile,
  ) => readonly PromptSlotContribution[];
  /** 本轮可见 Builtin Tool 的说明书槽;由 LocalHost 按冻结可见性装配。 */
  readonly toolPromptContribution?: (input: {
    sessionId: SessionId;
    turnId: TurnId;
    executionProfile: ExecutionProfile;
    narrativePolicy: NarrativePolicy;
    workspaceRoot: string;
  }) => Promise<PromptSlotContribution | null>;
  readonly scratchpadDirForTurn?: (
    sessionId: SessionId,
    turnId: TurnId,
  ) => string;
  readonly mediaCompatibility: MediaCompatibilityServices;
  readonly settingsForTurn: () => TurnSettingsSnapshot;
}

/** 输入准备只读取或持久化本轮输入，不创建、完成或失败 Turn。 */
export class TurnInputPreparer {
  constructor(private readonly deps: TurnInputPreparerDeps) {}

  async prepare(
    request: TurnPreparationRequest,
    context: TurnPreparationContext,
  ): Promise<TurnInput> {
    // 设置在任何附件写入或媒体降级前读取一次，确保同一根 Turn 不会混用新旧上限。
    const settings = freezeTurnSettings(this.deps.settingsForTurn());
    const model = this.resolveModel(request);
    const prepared = await this.prepareUserInput(
      request,
      context,
      model,
      settings,
    );
    const session = this.deps.session.getSession(context.turn.sessionId);
    const workspaceRoot = session.workspaceRoot ?? '';
    const toolPrompt = await this.deps.toolPromptContribution?.({
      sessionId: context.turn.sessionId,
      turnId: context.turn.id,
      executionProfile: request.executionProfile,
      narrativePolicy: request.narrativePolicy,
      workspaceRoot,
    }) ?? null;
    const extensionContributions = [
      ...(toolPrompt ? [toolPrompt] : []),
      ...(this.deps.extensionPromptContributions?.(request.executionProfile) ?? []),
    ];
    return Object.freeze({
      userInput: freezeUserInput(prepared.userInput),
      persistedUserInput: prepared.persistedUserInput,
      prompt: buildPromptSnapshot({
        activeCharacter: this.deps.activeCharacter(),
        executionProfile: request.executionProfile,
        narrativePolicy: request.narrativePolicy,
        extensionContributions,
      }),
      model,
      settings,
      workspaceRoot,
      scratchpadDir: request.executionProfile === 'work'
        ? this.deps.scratchpadDirForTurn?.(
            context.turn.sessionId,
            context.turn.id,
          )
        : undefined,
      kbIds: request.kbIds ? Object.freeze([...request.kbIds]) : undefined,
      kbAssetScopes: request.kbAssetScopes
        ? Object.freeze(request.kbAssetScopes.map((scope) => ({
            kbId: scope.kbId,
            assetIds: [...scope.assetIds],
          })))
        : undefined,
      thinking: request.thinking,
      requestDegradations: Object.freeze([...prepared.requestDegradations]),
    });
  }

  private resolveModel(request: TurnPreparationRequest): TurnModelSnapshot {
    if (!request.providerId || !request.model) {
      throw new TurnPreparationError(
        'provider/not_configured',
        `No LLM provider configured for ${request.executionProfile} profile`,
      );
    }

    const resolved = this.deps.modelCapabilities.resolve({
      providerId: request.providerId,
      model: request.model,
    });
    const capabilities = freezeCapabilities({
      ...resolved,
      contextWindow: this.deps.contextWindowFor(
        request.providerId,
        request.model,
      ) ?? resolved.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW,
    });

    return Object.freeze({
      providerId: request.providerId,
      model: request.model,
      capabilities,
    });
  }

  private async prepareUserInput(
    request: TurnPreparationRequest,
    context: TurnPreparationContext,
    model: TurnModelSnapshot,
    settings: TurnSettingsSnapshot,
  ): Promise<{
    readonly userInput: string | readonly LlmContentPart[];
    readonly persistedUserInput: MessageBlocks;
    readonly requestDegradations: readonly RequestDegradationNotice[];
  }> {
    let contentParts = request.contentParts
      ? request.contentParts.map((part) => ({ ...part }))
      : undefined;
    let userInput = request.userInput;
    let storedAttachments: Attachment[] = [];
    const requestDegradations: RequestDegradationNotice[] = [];

    try {
      if (request.attachmentInputs?.length) {
        storedAttachments = this.deps.attachments.addAll(
          [...request.attachmentInputs],
          context.turn.id as string,
          context.turn.sessionId as string,
          settings.attachment,
        );
        const resolved = await this.deps.attachments.resolveForPrompt(storedAttachments);

        if (resolved.imageParts.length > 0 || resolved.promptLines) {
          const parts: LlmContentPart[] = [
            ...resolved.imageParts.map((part) => ({ ...part })),
          ];
          if (contentParts?.length) {
            parts.push(...contentParts);
          } else if (userInput) {
            parts.push({ type: 'text', text: userInput });
          }
          if (resolved.promptLines) {
            parts.push({ type: 'text', text: resolved.promptLines });
          }
          contentParts = parts;
          userInput = '';
        }
      }

      const imageParts = contentParts?.filter(
        (part) => part.type === 'image_data' || part.type === 'image_url',
      ) ?? [];
      if (imageParts.length > 0) {
        const fallback = await prepareImagesForModel(
          this.deps.mediaCompatibility,
          model,
          imageParts,
          {
            sessionId: context.turn.sessionId,
            turnId: context.turn.id,
          },
          settings.attachment,
          context.signal,
        );
        contentParts = replaceImageParts(contentParts ?? [], fallback.parts);
        if (fallback.degradation) {
          requestDegradations.push(fallback.degradation);
        }
      }
    } catch (error) {
      const providerCode = llmProviderErrorCode(error);
      const code = providerCode === 'provider/model_capability_unsupported'
        ? providerCode
        : 'turn/attachment_failed';
      throw new TurnPreparationError(
        code,
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }

    const runtimeInput = contentParts?.length ? contentParts : userInput;
    return {
      userInput: runtimeInput,
      persistedUserInput: buildPersistedUserInput(
        runtimeInput,
        storedAttachments,
      ),
      requestDegradations,
    };
  }
}

export function buildPersistedUserInput(
  input: string | readonly LlmContentPart[],
  attachments: readonly Attachment[],
): MessageBlocks {
  if (typeof input === 'string' && attachments.length === 0) return input;

  const blocks: Array<LlmContentPart | AttachmentReferenceBlock> = [];
  if (typeof input === 'string') {
    if (input) blocks.push({ type: 'text', text: input });
  } else {
    for (const part of input) {
      if (
        part.type === 'image_data'
        || part.type === 'audio_data'
        || part.type === 'file_data'
      ) {
        blocks.push({
          type: 'text',
          text: `[本轮${mediaLabel(part.type)}正文未写入会话数据库]`,
        });
        continue;
      }
      blocks.push(part);
    }
  }

  for (const attachment of attachments) {
    blocks.push({
      type: 'attachment_ref',
      attachmentId: attachment.id,
      name: attachment.name,
      mimeType: attachment.mime,
    });
  }
  return blocks;
}

function freezeCapabilities(
  capabilities: ModelCapabilitySnapshot,
): ModelCapabilitySnapshot {
  return Object.freeze({
    ...capabilities,
    input: Object.freeze({ ...capabilities.input }),
  });
}

function freezeUserInput(
  input: string | readonly LlmContentPart[],
): string | readonly LlmContentPart[] {
  if (typeof input === 'string') return input;
  return Object.freeze(input.map((part) => Object.freeze({ ...part })));
}

function freezeTurnSettings(
  settings: TurnSettingsSnapshot,
): TurnSettingsSnapshot {
  return Object.freeze({
    agent: Object.freeze({ ...settings.agent }),
    attachment: Object.freeze({ ...settings.attachment }),
    contextCompaction: Object.freeze({ ...settings.contextCompaction }),
  });
}

function mediaLabel(type: 'image_data' | 'audio_data' | 'file_data'): string {
  if (type === 'image_data') return '图片';
  if (type === 'audio_data') return '音频';
  return '文件';
}
