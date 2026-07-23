// 定义 Artifact 创建、更新与应用产生的业务事件。
import type { SessionId } from '@ema-agent/ids';
import type { Artifact, ArtifactId } from './types.js';

export type ArtifactEvent =
  | { type: 'artifact_upserted'; sessionId: SessionId; artifact: Artifact }
  | { type: 'artifact_applied'; sessionId: SessionId; id: ArtifactId }
  | {
      type: 'artifact_count_warning';
      sessionId: SessionId;
      message: string;
    };
