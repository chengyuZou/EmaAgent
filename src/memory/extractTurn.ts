// 读取一条已完成 Turn 的 Memory 事实，并按 Work/Relationship 轨调用提取模型。

import type { MemoryExtractionJobKind } from '@ema-agent/storage';
import {
  runTurnExtraction,
  type CompletedTurnMemoryInput,
  type CompleteExtraction,
} from './common/extraction.js';
import { buildWorkExtractionInput, serializeWorkTurn } from './work/extraction.js';
import {
  buildRelationshipExtractionInput,
  serializeRelationshipTurn,
} from './relationship/extraction.js';
import {
  loadTemplate,
  type ExtractionTemplates,
} from './templates/loader.js';

export interface CreateExtractTurnDeps {
  /** 由 Turn/Server 将持久 Message、工作区和冻结角色投影为 Memory 自有输入。 */
  readonly loadCompletedTurn: (turnId: string) => Promise<CompletedTurnMemoryInput>;
  /** 应用层的 LLM 调用闭包(两段消息 → 输出纯文本)。 */
  readonly complete: CompleteExtraction;
  /** 提取模板覆盖(可选);缺省用内置 md。 */
  readonly templates?: Partial<ExtractionTemplates>;
}

/** runExtractionJobs 需要的提取闭包签名。 */
export type ExtractTurn = (input: {
  readonly kind: MemoryExtractionJobKind;
  readonly turnId: string;
  readonly signal: AbortSignal;
}) => Promise<string | undefined>;

/** 组装 extractTurn 闭包。 */
export function createExtractTurn(deps: CreateExtractTurnDeps): ExtractTurn {
  return async ({ kind, turnId, signal }) => {
    const turn = await deps.loadCompletedTurn(turnId);

    if (kind === 'work_extraction') {
      const [workSystem, workInput] = await Promise.all([
        deps.templates?.workSystem ?? loadTemplate('workSystem'),
        deps.templates?.workInput ?? loadTemplate('workInput'),
      ]);
      return runTurnExtraction(
        workSystem,
        workInput,
        serializeWorkTurn(buildWorkExtractionInput(turn.messages, turn.workspaceRoot)),
        deps.complete,
        signal,
      );
    }

    // relationship_extraction:无角色归属的 Turn 不提(不知道写给谁)。
    const characterDirectoryName = turn.characterDirectoryName;
    if (!characterDirectoryName) return undefined;
    const [relationshipSystem, relationshipInput] = await Promise.all([
      deps.templates?.relationshipSystem ?? loadTemplate('relationshipSystem'),
      deps.templates?.relationshipInput ?? loadTemplate('relationshipInput'),
    ]);
    return runTurnExtraction(
      relationshipSystem,
      relationshipInput,
      serializeRelationshipTurn(
        buildRelationshipExtractionInput(turn.messages, characterDirectoryName),
      ),
      deps.complete,
      signal,
    );
  };
}
