import {
  VishotCapture,
  vishotCaptureEnabledSetting,
  vishotCaptureIntervalSecondsSetting,
} from '@ema-agent/vishot-capture';
import type { SettingsStore } from '@ema-agent/settings';
import type { SessionContinuationQueue } from '@ema-agent/turn';
import type { DatabaseComposition } from './database.js';
import type { ProvidersComposition } from './providers.js';
import type { AppEvents } from '../application/appEvents.js';
import type { ComputerUse } from '@ema-agent/computer-use';

export function openVishotCapture(
  database: DatabaseComposition,
  settings: SettingsStore,
  providers: ProvidersComposition,
  isIdle: (sessionId: string) => boolean,
  enqueue: SessionContinuationQueue['enqueueIfIdleForVishotCapture'],
  appEvents: AppEvents,
  computerUse?: ComputerUse,
): { readonly capture: VishotCapture; close(): Promise<void> } {
  const canSubmit = (sessionId: string): boolean => {
    if (computerUse?.state || !isIdle(sessionId)) return false;
    const session = database.session.getSession(sessionId);
    if (!session.providerId || !session.modelId) return false;
    const model = providers.providerModels.get(session.providerId, 'llm', session.modelId);
    if (!model || model.capability !== 'llm') return false;
    try {
      providers.providers.resolveConnection(session.providerId, 'llm');
      if (model.inputImage === true) return true;
      const vision = providers.modelBindings.get('vision');
      if (!vision) return false;
      providers.providers.resolveConnection(vision.providerId, 'vision');
      return true;
    } catch {
      return false;
    }
  };
  const capture = new VishotCapture({
    readSettings: () => ({
      enabled: settings.get(vishotCaptureEnabledSetting),
      intervalSeconds: settings.get(vishotCaptureIntervalSecondsSetting),
    }),
    canStartCapture: canSubmit,
    shouldSubmitCapture: canSubmit,
    captureImage: computerUse ? signal => computerUse.capture(signal) : undefined,
    saveImage: (sessionId, bytes) => database.imageStore.saveImage(sessionId, bytes, '屏幕截图'),
    enqueueIfIdleForVishotCapture: (sessionId, imagePath) => enqueue({
      sessionId,
      input: [{ type: 'attachment', block: { type: 'image_reference', path: imagePath, name: '屏幕截图' } }],
    }),
    onError: error => appEvents.emit({
      type: 'system_warning',
      level: 'warn',
      message: `自动屏幕捕获失败: ${error instanceof Error ? error.message : String(error)}`,
    }),
  });
  const stopControlUpdates = computerUse?.subscribe(() => capture.configure());
  const unsubscribe = settings.subscribe(event => {
    if (event.changedKeys.some(key => key === vishotCaptureEnabledSetting.key
      || key === vishotCaptureIntervalSecondsSetting.key)) {
      capture.configure();
    }
  });
  return {
    capture,
    async close() {
      unsubscribe();
      stopControlUpdates?.();
      await capture.close();
    },
  };
}
