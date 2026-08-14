// 把 data.db 的流式快照、原子恢复与便携恢复判定装配成 Session 备份入口。
import { SessionBackupFacade } from '@ema-agent/backup';
import { asSessionId } from '@ema-agent/ids';
import type { KbManager } from '@ema-agent/knowledge';
import type { SessionStore } from '@ema-agent/session';
import {
  SessionBackupReader,
  SessionBackupRestorer,
  type Database,
  type ProviderLlmModelsRepo,
} from '@ema-agent/storage';

export function createSessionBackup(
  activeDataDir: string,
  dataDb: Database,
  session: SessionStore,
  providerLlmModels: Pick<ProviderLlmModelsRepo, 'hasProviderModel'>,
  kb: Pick<KbManager, 'getKb'>,
): SessionBackupFacade {
  return new SessionBackupFacade({
    activeDataDir,
    reader: new SessionBackupReader(dataDb.sqlite),
    restorer: new SessionBackupRestorer(dataDb.sqlite),
    sessionExists: sessionId => session.sessionExists(asSessionId(sessionId)),
    // 便携恢复只信目标侧真实存在的 Provider+模型对与 KB,缺失由导入侧清空并警告。
    modelPreferenceExists: (providerConfigId, modelId) =>
      providerLlmModels.hasProviderModel(providerConfigId, modelId),
    kbExists: kbId => kb.getKb(kbId) !== undefined,
  });
}
