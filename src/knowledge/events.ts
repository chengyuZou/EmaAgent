// 定义 Knowledge 后台导入与重嵌入向宿主公开的最终业务事件。

export type KnowledgeEvent =
  | {
      readonly type: 'kb_ingest_progress';
      readonly kbId: string;
      readonly taskId: string;
      readonly assetId: string;
      readonly stage: 'validate' | 'parse' | 'chunk' | 'embed';
      readonly progress: number;
    }
  | {
      readonly type: 'kb_ingest_completed';
      readonly kbId: string;
      readonly taskId: string;
      readonly assetId: string;
    }
  | {
      readonly type: 'kb_ingest_failed';
      readonly kbId: string;
      readonly taskId: string;
      readonly assetId: string;
      readonly error: string;
    }
  | {
      readonly type: 'kb_ingest_cancelled';
      readonly kbId: string;
      readonly taskId: string;
      readonly assetId: string;
    }
  | {
      readonly type: 'kb_reembed_progress';
      readonly kbId: string;
      readonly taskId: string;
      readonly assetId: string;
      readonly progress: number;
      readonly completed: number;
      readonly total: number;
    }
  | {
      readonly type: 'kb_reembed_completed';
      readonly kbId: string;
      readonly taskId: string;
      readonly assetId: string;
    }
  | {
      readonly type: 'kb_reembed_cancelled';
      readonly kbId: string;
      readonly taskId: string;
      readonly assetId: string;
    }
  | {
      readonly type: 'kb_reembed_failed';
      readonly kbId: string;
      readonly taskId: string;
      readonly assetId: string;
      readonly error: string;
    };
