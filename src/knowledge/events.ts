// 定义 Knowledge 后台导入与重嵌入向宿主公开的最终业务事件。

export type KnowledgeEvent =
  | {
      /** 库创建、改名或删除已完成; 其他窗口重新读取库列表. */
      readonly type: 'kb_library_list_changed';
    }
  | {
      /** 激活库已切换; Chat 丢弃所有尚未发送的旧库文档选择, 再重读库列表. */
      readonly type: 'kb_active_changed';
      readonly kbId: string | null;
    }
  | {
      readonly type: 'kb_document_deleted';
      readonly kbId: string;
      readonly assetId: string;
    }
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
