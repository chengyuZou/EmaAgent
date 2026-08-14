// 装配附件记录、图片派生缓存与空闲维护器，不在构造阶段执行文件操作。

import {
  AttachmentCacheMaintenance,
  AttachmentDerivationCache,
  AttachmentStore,
  attachmentSetting,
} from '@ema-agent/attachment';
import type { SessionStore } from '@ema-agent/session';
import type { SettingsStore } from '@ema-agent/settings';
import {
  AttachmentDerivationsRepo,
  AttachmentRepo,
  type Database,
} from '@ema-agent/storage';

export function createAttachmentRuntime(
  dataDb: Database,
  activeDataDir: string,
  session: SessionStore,
  settings: SettingsStore,
) {
  const derivations = new AttachmentDerivationsRepo(dataDb.sqlite);

  return {
    attachmentStore: new AttachmentStore(
      new AttachmentRepo(dataDb.sqlite),
      session,
    ),
    attachmentDerivationCache: new AttachmentDerivationCache({
      activeDataDir,
      repo: derivations,
    }),
    attachmentCacheMaintenance: new AttachmentCacheMaintenance({
      activeDataDir,
      repo: derivations,
      isIdle: () => !session.hasActiveTurns(),
      // 配额在每次真正清理开始时读取，运行中的清理继续使用同一份值。
      maxBytesForSweep: () =>
        settings.get(attachmentSetting).derivationCacheBytes,
    }),
  };
}
