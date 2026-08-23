// 备份一族：Session 便携 ZIP 导入导出的唯一业务入口装配。
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
      // 跨机语义：目标侧存在同 Provider + 模型的已启用行才恢复模型偏好，否则清空并提示。
      (providerId, modelId) => {
        const facts = providerModels.get(providerId, 'llm', modelId);
        return facts !== undefined && facts !== null && facts.capability === 'llm';
      },
    ),
  };
}
