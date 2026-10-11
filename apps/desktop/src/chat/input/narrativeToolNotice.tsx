import {
  memo, useEffect, useMemo, useState, type JSX } from 'react';
import { isWitchTrialCharacter } from '@ema-agent/narrative/isWitchTrialCharacter';
import { BuiltinTools } from '@ema-agent/tools/identity';
import { Button, Callout, IconButton } from '@ema-agent/ui';
import type { ProviderRecord } from '../../api/providers.js';
import { settingsApi } from '../../api/settings.js';
import { useWindowSuspension } from '../../hooks/use-window-suspension.js';
import { MainView, useMainNavigationStore } from '../../layout/navigation.js';
import { subscribeSystemEvent } from '../../lib/system-event-dispatcher.js';
import { useCharacterStore } from '../../stores/character.js';
import { useProviderStore, type ProviderStoreState } from '../../stores/provider.js';
import { useServerStore } from '../../stores/server.js';

const NON_GAME_CHARACTER_MESSAGE = '当前角色不在游戏剧情角色名单中, 已自动停用 NarrativeSearch, 避免引入无关剧情造成 OOC (角色表现偏离设定). 工具开关保持不变.';
const NARRATIVE_BINDINGS = ['narrative-llm', 'narrative-embed'] as const;

interface NoticeContent {
  readonly kind: 'configuration' | 'character' | 'settings';
  readonly message: string;
}

function getNarrativeConfigurationIssues(
  bindings: ProviderStoreState['bindings'],
  providers: readonly ProviderRecord[],
): string[] {
  const issues: string[] = [];
  for (const module of NARRATIVE_BINDINGS) {
    const binding = bindings[module];
    if (!binding) {
      issues.push(`${module} 未绑定`);
      continue;
    }

    const provider = providers.find(item => item.id === binding.providerId);
    if (!provider) {
      issues.push(`${module} 的供应商配置尚不可用`);
      continue;
    }

    const capability = provider.capabilities.find(item => item.capability === binding.capability);
    const protocol = capability?.protocols.find(item => item.protocol === capability.activeProtocol);
    if (!protocol) {
      issues.push(`${module} 的供应商未启用 ${binding.capability} 协议`);
    } else if (provider.authType === 'bearer' && !provider.hasKey) {
      issues.push(`${module} 的供应商缺少 API Key`);
    }
  }
  return issues;
}

function configurationMessage(issues: readonly string[]): string {
  return `尚未提供 NarrativeSearch: ${issues.join('; ')}. 补齐配置后下一轮对话生效.`;
}

function getNarrativeToolNotice(
  characterName: string | null,
  issues: readonly string[],
  enabled: boolean | null,
): NoticeContent | null {
  if (!characterName || !enabled) {
    return null;
  }

  if (isWitchTrialCharacter(characterName)) {
    if (issues.length === 0) {
      return null;
    }
    return { kind: 'configuration', message: configurationMessage(issues) };
  }

  // 未配置剧情模型, 也不是剧情角色时没有需要用户处理的事项, Chat 不显示提示.
  if (issues.length > 0) {
    return null;
  }
  return { kind: 'character', message: NON_GAME_CHARACTER_MESSAGE };
}

function useNarrativeConfiguration() {
  const characterName = useCharacterStore(state => state.activeName);
  const providers = useProviderStore(state => state.providers);
  const bindings = useProviderStore(state => state.bindings);
  const issues = useMemo(
    () => getNarrativeConfigurationIssues(bindings, providers),
    [bindings, providers],
  );
  return { characterName, issues };
}

function openNarrativeBindings(): void {
  useMainNavigationStore.getState().setSettingsTab('bindings');
}

export const NarrativeToolNotice = memo(function NarrativeToolNotice(): JSX.Element {
  const { characterName, issues } = useNarrativeConfiguration();
  const view = useMainNavigationStore(state => state.activeView);
  const serverReady = useServerStore(state => state.status.kind === 'ok');
  const suspended = useWindowSuspension();
  const active = view === MainView.Chat && serverReady && !suspended;
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!active) {
      return;
    }

    let disposed = false;
    let request = 0;
    setEnabled(null);
    setReadFailed(false);

    const readEnabled = async (): Promise<void> => {
      const currentRequest = ++request;
      try {
        const result = await settingsApi.getValue('tools.disabled');
        const disabled = result.value;
        if (!Array.isArray(disabled) || disabled.some(id => typeof id !== 'string')) {
          throw new Error('tools.disabled 没有返回字符串数组');
        }
        // 返回 Settings 或隐藏窗口后, 不让迟到响应更新当前提示; 重叠请求只使用最后一次.
        if (disposed || currentRequest !== request) {
          return;
        }
        setEnabled(!disabled.includes(BuiltinTools.NarrativeSearch.id));
        setReadFailed(false);
      } catch {
        if (disposed || currentRequest !== request) {
          return;
        }
        setEnabled(null);
        setReadFailed(true);
      }
    };

    const unsubscribe = subscribeSystemEvent(event => {
      if (event.type === 'settings_changed') {
        void readEnabled();
      }
    });
    void readEnabled();
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [active, retry]);

  const notice = useMemo<NoticeContent | null>(() => {
    if (readFailed) {
      return { kind: 'settings', message: 'NarrativeSearch 的工具开关读取失败, 请重试.' };
    }
    return getNarrativeToolNotice(characterName, issues, enabled);
  }, [characterName, issues, enabled, readFailed]);
  // 提示消失时保留最后一段正文, 让容器能完整播放收起动画, 而不是先清空内容再突然变矮.
  const [lastNotice, setLastNotice] = useState<NoticeContent | null>(null);
  useEffect(() => {
    if (notice) {
      setLastNotice(notice);
    }
  }, [notice]);

  const noticeKey = notice ? `${characterName ?? ''}\n${notice.kind}\n${notice.message}` : null;
  const visible = active && noticeKey !== null && dismissedKey !== noticeKey;
  const content = notice ?? lastNotice;

  return (
    <div
      className="ema-collapsible"
      style={{ gridTemplateRows: visible ? '1fr' : '0fr', opacity: visible ? 1 : 0 }}
      aria-hidden={!visible}
    >
      <div className="min-h-0" style={{ pointerEvents: visible ? 'auto' : 'none' }}>
        {content && (
          <Callout
            variant={content.kind === 'character' ? 'info' : 'warn'}
            className="mb-2"
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-xs leading-relaxed">{content.message}</p>
                {content.kind !== 'character' && (
                  <Button
                    size="sm"
                    shape="rounded"
                    variant="ghost"
                    className="mt-1"
                    disabled={!visible}
                    onClick={() => {
                      if (content.kind === 'settings') {
                        setRetry(value => value + 1);
                      } else {
                        openNarrativeBindings();
                      }}}
                  >
                    {content.kind === 'settings' ? '重试' : '去配置'}
                  </Button>
                )}
              </div>
              <IconButton
                size="sm"
                variant="ghost"
                shape="rounded"
                icon="i-lucide:x"
                label="关闭 Narrative 提示"
                disabled={!visible}
                onClick={() => setDismissedKey(noticeKey)}
              />
            </div>
          </Callout>
        )}
      </div>
    </div>
  );
});

export const NarrativeToolStatus = memo(function NarrativeToolStatus({
  enabled,
}: {
  readonly enabled: boolean;
}): JSX.Element {
  const { characterName, issues } = useNarrativeConfiguration();
  let message: string;
  let needsConfiguration = false;

  if (!enabled) {
    message = 'NarrativeSearch 已手动关闭, 下一轮对话不提供此工具.';
  } else if (!characterName) {
    message = '等待读取当前角色.';
  } else if (!isWitchTrialCharacter(characterName)) {
    message = NON_GAME_CHARACTER_MESSAGE;
  } else if (issues.length > 0) {
    message = configurationMessage(issues);
    needsConfiguration = true;
  } else {
    message = '当前角色和模型配置已就绪, 下一轮对话可使用 NarrativeSearch. 是否调用由模型决定.';
  }

  return (
    <div className="px-4 pb-3 text-xs leading-relaxed text-[var(--ema-text-secondary)]" role="note">
      <p>{message}</p>
      {needsConfiguration && (
        <Button
          size="sm"
          variant="ghost"
          className="mt-1"
          shape="rounded"
          onClick={openNarrativeBindings}
        >
          配置 Narrative 模型
        </Button>
      )}
    </div>
  );
});
