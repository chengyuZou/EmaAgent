import { SessionBackup } from '@ema-agent/backup';
import type { ProviderModels } from '@ema-agent/providers';
import { SessionBackupReader, SessionBackupRestorer, type Database } from '@ema-agent/storage';

export interface BackupComposition {
  readonly sessionBackup: SessionBackup;
}

export function openBackup(
  dataDb: Database,
  activeDataDir: string,
  providerModels: ProviderModels,
): BackupComposition {
  return {
    sessionBackup: new SessionBackup(
      activeDataDir,
      new SessionBackupReader(dataDb.sqlite),
      new SessionBackupRestorer(dataDb.sqlite),
      // 导入时按目标机器的 Provider 和 LLM 模型记录检查偏好, 不直接信任备份里的身份.
      (providerId, modelId) => {
        const facts = providerModels.get(providerId, 'llm', modelId);
        return facts !== undefined && facts !== null && facts.capability === 'llm';
      },
    ),
  };
}
