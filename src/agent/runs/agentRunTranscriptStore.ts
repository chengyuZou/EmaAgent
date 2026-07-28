// AgentRun transcript 存储把 SQLite 行映射成稳定领域消息，供执行追加和外部查询共用。

import type { AgentRunId } from '@ema-agent/ids';
import type {
  AgentRunMessageInsert,
  AgentRunMessageRow,
} from '@ema-agent/storage';
import type {
  AgentRunTranscriptAppend,
  AgentRunTranscriptMessage,
  AgentRunTranscriptReader,
  AgentRunTranscriptWriter,
} from './types.js';

interface AgentRunTranscriptRepository {
  insert(message: AgentRunMessageInsert): void;
  listForRun(agentRunId: AgentRunId): AgentRunMessageRow[];
}

export class AgentRunTranscriptStore
implements AgentRunTranscriptWriter, AgentRunTranscriptReader {
  constructor(private readonly repo: AgentRunTranscriptRepository) {}

  insert(message: AgentRunTranscriptAppend): void {
    this.repo.insert(message);
  }

  listForRun(agentRunId: AgentRunId): readonly AgentRunTranscriptMessage[] {
    return this.repo.listForRun(agentRunId).map((row) => ({
      id: row.id,
      agentRunId: row.agent_run_id,
      role: row.role,
      content: JSON.parse(row.content_json) as unknown,
      sequence: row.sequence,
      createdAt: row.created_at,
    }));
  }
}
