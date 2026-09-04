// 任务 Tab:正在查看的知识库的摄入与重嵌队列(SSE 驱动刷新) + 整库重建入口。
import type { JSX } from 'react';
import type { KnowledgeLibrary } from '../../api/knowledge.js';
import { ProcessingQueue } from './ProcessingQueue.js';

export function KbTasksTab({ lib }: { lib: KnowledgeLibrary }): JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <ProcessingQueue kbId={lib.id} staleCount={lib.staleCount} />
    </div>
  );
}
