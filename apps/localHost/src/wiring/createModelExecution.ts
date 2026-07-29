// 创建无 Session 状态的模型执行运行时，并连接用量记录、动态设置与 Provider 刷新入口。

import path from 'node:path';
import type { CredentialFacade } from '@ema-agent/credential';
import { EmbedRuntime } from '@ema-agent/embed';
import { LanguageModelRuntime } from '@ema-agent/llm';
import { NarrativeClient } from '@ema-agent/narrative';
import type { ModelCapabilityResolver } from '@ema-agent/provider';
import { RerankRuntime } from '@ema-agent/rerank';
import type { SettingsStore } from '@ema-agent/settings';
import { UsageRecordsRepo, type Database } from '@ema-agent/storage';
import {
  FsAudioArchive,
  TtsVoiceHandleCache,
} from '@ema-agent/tts';
import type { UsageRecord } from '@ema-agent/usage';
import { visionSetting } from '@ema-agent/vision';
import { resolveBridgeUrl } from './bridge.js';
import { ProviderRuntimeFacade } from './provider-runtime.js';
import { loadEmbedConfigs } from './providers/embed.js';
import { loadLlmConfigs } from './providers/llm.js';
import { loadRerankConfigs } from './providers/rerank.js';
import { buildSttRuntime } from './providers/stt.js';
import { buildTtsRuntime } from './providers/tts.js';
import { buildVisionRuntime } from './providers/vision.js';

export function createModelExecution(
  profileDb: Database,
  dataDb: Database,
  activeDataDir: string,
  credentials: CredentialFacade,
  settings: SettingsStore,
  modelCapabilities: ModelCapabilityResolver,
) {
  const usageRecords = new UsageRecordsRepo(dataDb.sqlite);
  const onUsageRecordError = (error: unknown, record: UsageRecord): void => {
    console.error(`[usage] 调用记录写入失败: ${record.id}`, error);
  };

  const llm = new LanguageModelRuntime(
    loadLlmConfigs(profileDb, credentials),
    undefined,
    {
      modelCapabilities,
      usageRecorder: usageRecords,
      onUsageRecordError,
    },
  );
  const embed = new EmbedRuntime(
    loadEmbedConfigs(profileDb, credentials),
    { usageRecorder: usageRecords, onUsageRecordError },
  );
  const rerank = new RerankRuntime(
    loadRerankConfigs(profileDb, credentials),
    { usageRecorder: usageRecords, onUsageRecordError },
  );
  const narrative = new NarrativeClient({
    baseUrl: resolveBridgeUrl(),
    secret: process.env['EMA_SHARED_SECRET'],
    timeoutMs: 60_000,
  });
  const tts = buildTtsRuntime({
    profileDb,
    credentials,
    usageRecorder: usageRecords,
    onUsageRecordError,
  });
  const ttsVoiceHandles = new TtsVoiceHandleCache();
  const stt = buildSttRuntime({
    profileDb,
    credentials,
    usageRecorder: usageRecords,
    onUsageRecordError,
  });
  const vision = buildVisionRuntime(
    profileDb,
    credentials,
    usageRecords,
    onUsageRecordError,
    () => settings.get(visionSetting),
  );
  const providerRuntime = new ProviderRuntimeFacade({
    profileDb,
    llm,
    embed,
    rerank,
    tts,
    stt,
    vision,
    narrative,
    credentials,
  });
  const audioArchive = new FsAudioArchive(
    path.join(activeDataDir, 'sessions'),
  );

  return {
    usageRecords,
    llm,
    embed,
    rerank,
    narrative,
    tts,
    ttsVoiceHandles,
    stt,
    vision,
    providerRuntime,
    audioArchive,
  };
}
