import { lazy, Suspense, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Button, DropdownMenu, IconButton, Tooltip, type MenuItem } from '@ema-agent/ui';
import { ChatPage } from '../chat/ChatPage.js';
import { subscribeSystemEvent } from '../lib/events/systemEventDispatcher.js';
import { mountSystemEvents } from '../lib/events/systemSse.js';
import { tauriBridge } from '../lib/tauri/tauriBridge.js';
import { showToast } from '../lib/notifications/toast.js';
import { mountDesktopNotifications } from '../lib/notifications/desktopNotifications.js';
import { ImageViewerProvider } from '../lib/images/imageViewer.js';
import { MarkdownMedia } from '../lib/markdownMedia.js';
import { handleBackgroundProcessSystemEvent } from '../stores/backgroundProcess.js';
import { handleCharacterSystemEvent, useCharacterStore } from '../stores/character.js';
import { handleMcpSystemEvent, useMcpStore } from '../stores/mcp.js';
import { handleProviderSystemEvent, useProviderStore } from '../stores/provider.js';
import { useServerStore } from '../stores/server.js';
import { useSessionPanelStore } from '../stores/sessionPanel.js';
import { handleSettingsSystemEvent } from '../stores/settings.js';
import { useSessionStore } from '../stores/session.js';
import { useSettingsSync } from '../stores/settings-sync.js';
import { handleSkillSystemEvent, useSkillStore } from '../stores/skill.js';
import { handleTaskSystemEvent } from '../stores/task.js';
import { useThemeSync } from '../stores/theme.js';
import { WallpaperLayer } from '../wallpaper/WallpaperLayer.js';
import { MainView, useMainNavigationStore } from './navigation.js';
import { setVishotCaptureSession } from '../api/vishotCapture.js';
import { mountAudioPlayback, receiveAudioPlaybackSystemEvent, useAudioPlaybackStore } from '../stores/audioPlayback.js';
import { receiveAudioSystemEvent } from '../stores/audio.js';
import { SessionRequestError, sessionWebSocket } from '../api/sessionWebSocket.js';
import { ensureSessionSubscription } from '../chat/session/sessionSubscriptions.js';
import type { StageVoiceContextChange, StageVoiceSendRequest, StageVoiceSendResult } from '../lib/tauri/types.js';

const SettingsPanel = lazy(async () => {
  const module = await import('../settings/SettingsPanel.js');
  return { default: module.SettingsPanel };
});

async function sendStageVoiceText(request: StageVoiceSendRequest): Promise<StageVoiceSendResult> {
  const { requestId, sessionId, text } = request;
  let submitted = false;
  try {
    await useSessionStore.getState().waitForModelSettings(sessionId);
    const session = useSessionStore.getState().sessions.byId.get(sessionId);
    if (!session) throw new Error('会话已不可用');
    if (!session.providerId || !session.modelId) throw new Error('请先为该会话选择模型');
    ensureSessionSubscription(sessionId);
    submitted = true;
    await sessionWebSocket.sendUserMessage(sessionId, { input: [{ type: 'text', text }] });
    return { requestId, status: 'accepted' };
  } catch (error) {
    const rejected = !submitted || (error instanceof SessionRequestError && [
      'empty_input', 'session_busy', 'session_not_found', 'session_archived', 'session_stopping',
    ].includes(error.code));
    const message = error instanceof Error ? error.message : '语音草稿发送失败';
    return { requestId, status: rejected ? 'rejected' : 'unknown', message };
  }
}

function mountStageVoiceInput(): () => void {
  if (!tauriBridge.isTauri()) return () => {};
  let disposed = false;
  let hasSessionList = useSessionStore.getState().sessions.byId.size > 0;
  let contextPublication = Promise.resolve();
  const publish = (change: StageVoiceContextChange): void => {
    // 归档后马上恢复时, Stage 必须先收到移除, 才能取消旧录音和转写.
    contextPublication = contextPublication.then(async () => {
      if (!disposed) await tauriBridge.publishStageVoiceContext(change);
    }).catch(error => console.warn('[stage-voice]', error));
  };
  const publishSessions = (): void => {
    // 初始化时的空列表不能用来删除 Stage 已有的草稿. 等到 Store 交付实际列表再发.
    if (!hasSessionList) return;
    const { sessions } = useSessionStore.getState();
    publish({
      type: 'sessions',
      sessions: Array.from(sessions.byId.values(), session => ({ sessionId: session.id, title: session.title })),
    });
  };
  const publishCurrentContext = (): void => {
    publishSessions();
    publish({ type: 'viewed-session', sessionId: useMainNavigationStore.getState().viewedSessionId });
    publish({ type: 'playback', isPlaying: useAudioPlaybackStore.getState().playbackStatus === 'playing' });
  };
  const subscriptions = [
    useSessionStore.subscribe((state, previous) => {
      if (state.sessions.byId === previous.sessions.byId) return;
      hasSessionList = true;
      publishSessions();
    }),
    useMainNavigationStore.subscribe((state, previous) => {
      if (state.viewedSessionId !== previous.viewedSessionId) {
        publish({ type: 'viewed-session', sessionId: state.viewedSessionId });
      }
    }),
    useAudioPlaybackStore.subscribe((state, previous) => {
      const isPlaying = state.playbackStatus === 'playing';
      if (isPlaying !== (previous.playbackStatus === 'playing')) publish({ type: 'playback', isPlaying });
    }),
  ];
  const listening = [
    tauriBridge.listenStageVoiceContextRequest(() => { if (!disposed) publishCurrentContext(); }),
    tauriBridge.listenStageVoiceSend(request => {
      if (disposed || typeof request?.requestId !== 'string' || typeof request.sessionId !== 'string'
        || typeof request.text !== 'string' || !request.text.trim()) return;
      void sendStageVoiceText(request).then(result => tauriBridge.publishStageVoiceSendResult(result))
        .catch(error => console.warn('[stage-voice]', error));
    }),
  ];
  // Stage 可能比 main 先打开. main 注册接收入口后也主动发送一次当前状态.
  void Promise.all(listening).then(() => { if (!disposed) publishCurrentContext(); })
    .catch(error => console.warn('[stage-voice]', error));
  return () => {
    disposed = true;
    subscriptions.forEach(unsubscribe => unsubscribe());
    listening.forEach(subscription => { void subscription.then(unlisten => unlisten()).catch(() => {}); });
  };
}

export function MainWindow(): JSX.Element {
  const activeView = useMainNavigationStore(state => state.activeView);
  const sessionId = useMainNavigationStore(state => state.viewedSessionId);
  const cwd = useSessionStore(state => state.sessions.byId.get(sessionId ?? '')?.cwd);
  const openWorkspaceFile = useSessionPanelStore(state => state.openWorkspaceFile);
  const openFile = useMemo(() => {
    if (!sessionId) {
      return undefined;
    }
    return (path: string) => openWorkspaceFile(sessionId, path);
  }, [sessionId, openWorkspaceFile]);
  const sidebarOpen = useMainNavigationStore(state => state.sidebarOpen);
  const setActiveView = useMainNavigationStore(state => state.setActiveView);
  const toggleSidebar = useMainNavigationStore(state => state.toggleSidebar);
  const goBack = useMainNavigationStore(state => state.goBack);
  const goForward = useMainNavigationStore(state => state.goForward);
  const canGoBack = useMainNavigationStore(state => state.historyIndex > 0);
  const canGoForward = useMainNavigationStore(state => state.historyIndex < state.history.length - 1);
  const serverReady = useServerStore(state => state.status.kind === 'ok');
  // 只记录已打开的 View 名称. 保持对应组件挂载, 才能保留草稿和未完成操作.
  const [openedViews, setOpenedViews] = useState<ReadonlySet<MainView>>(() => new Set([MainView.Chat]));
  const [maximized, setMaximized] = useState(false);
  const imageViewerRoot = useRef<HTMLDivElement>(null);

  useThemeSync();
  useEffect(() => mountDesktopNotifications(), []);
  useEffect(() => mountAudioPlayback(), []);
  useEffect(() => mountStageVoiceInput(), []);
  useSettingsSync(serverReady);
  useEffect(() => {
    if (!serverReady) return;
    void setVishotCaptureSession(sessionId).catch(error => {
      showToast(`屏幕捕获目标同步失败: ${error instanceof Error ? error.message : String(error)}`, { variant: 'danger' });
    });
  }, [serverReady, sessionId]);
  useEffect(() => () => {
    void setVishotCaptureSession(null).catch(() => undefined);
  }, []);
  useEffect(() => mountSystemEvents({ ownsConnection: false }), []);
  useEffect(() => useServerStore.getState().startPolling(), []);
  useEffect(() => subscribeSystemEvent(event => {
    handleBackgroundProcessSystemEvent(event);
    handleCharacterSystemEvent(event);
    handleMcpSystemEvent(event);
    handleProviderSystemEvent(event);
    handleSettingsSystemEvent(event);
    handleSkillSystemEvent(event);
    handleTaskSystemEvent(event);
    receiveAudioSystemEvent(event);
    receiveAudioPlaybackSystemEvent(event);
  }), []);
  useEffect(() => {
    if (!serverReady) {
      return;
    }
    void useProviderStore.getState().loadAll();
    void useCharacterStore.getState().load();
    void useSkillStore.getState().load();
    void useMcpStore.getState().load();
  }, [serverReady]);
  useEffect(() => {
    setOpenedViews(previous => {
      if (previous.has(activeView)) {
        return previous;
      }
      return new Set([...previous, activeView]);
    });
  }, [activeView]);
  useEffect(() => {
    let disposed = false;
    let stop = () => {};
    void tauriBridge.listenWindowMaximized(value => {
      if (!disposed) {
        setMaximized(value);
      }
    }).then(unlisten => {
      if (disposed) {
        unlisten();
      } else {
        stop = unlisten;
      }
    }).catch(error => console.warn('[main] 读取窗口大小状态失败', error));
    return () => {
      disposed = true;
      stop();
    };
  }, []);

  function runWindowAction(action: () => Promise<void>): void {
    void action().catch(error => {
      showToast(error instanceof Error ? error.message : '窗口操作失败', { variant: 'danger' });
    });
  }

  const views = new Set([...openedViews, activeView]);
  const fileItems: MenuItem[] = [
    {
      kind: 'item',
      label: '关闭主窗口',
      onSelect: () => runWindowAction(() => tauriBridge.hideMainWindow()),
    },
    {
      kind: 'item',
      label: '退出 Ema',
      onSelect: () => runWindowAction(() => tauriBridge.quit()),
    },
  ];

  return (
    <ImageViewerProvider rootRef={imageViewerRoot}>
      <div
        className="ema-main-window"
        data-maximized={maximized}
      >
        <WallpaperLayer />
        <header className="ema-main-titlebar">
          <Tooltip content="返回" side="bottom">
            <IconButton
              size="sm"
              variant="ghost"
              shape="rounded"
              label="返回"
              icon="i-lucide:arrow-left"
              disabled={!canGoBack}
              onClick={goBack}
            />
          </Tooltip>
          <Tooltip content="前进" side="bottom">
            <IconButton
              size="sm"
              variant="ghost"
              shape="rounded"
              label="前进"
              icon="i-lucide:arrow-right"
              disabled={!canGoForward}
              onClick={goForward}
            />
          </Tooltip>
          {activeView === MainView.Chat && (
            <Tooltip content={sidebarOpen ? '隐藏侧栏' : '显示侧栏'} side="bottom">
              <IconButton
                size="sm"
                variant="ghost"
                shape="rounded"
                label={sidebarOpen ? '隐藏侧栏' : '显示侧栏'}
                icon={sidebarOpen ? 'i-main:sidebarExpanded' : 'i-main:sidebarCollapsed'}
                aria-expanded={sidebarOpen}
                onClick={toggleSidebar}
              />
            </Tooltip>
          )}
          <DropdownMenu
            items={fileItems}
            side="bottom"
            align="start"
            trigger={(
              <Button
                variant="ghost"
                size="sm"
                className="ema-main-menu-trigger"
              >
                文件
              </Button>
            )}
          />
          <div
            className="ema-main-titlebar-drag"
            onMouseDown={event => {
              if (event.button === 0 && event.detail === 1) {
                runWindowAction(() => tauriBridge.startDragging());
              }
            }}
            onDoubleClick={() => runWindowAction(() => tauriBridge.toggleMaximizeWindow())}
          >
          </div>
          <div className="ema-main-window-controls">
            <Tooltip content="最小化">
              <button
                type="button"
                aria-label="最小化"
                onClick={() => runWindowAction(() => tauriBridge.minimizeWindow())}
              >
                <span className="i-lucide:minus" aria-hidden />
              </button>
            </Tooltip>
            <Tooltip content={maximized ? '还原窗口' : '最大化'}>
              <button
                type="button"
                aria-label={maximized ? '还原窗口' : '最大化'}
                onClick={() => runWindowAction(() => tauriBridge.toggleMaximizeWindow())}
              >
                <span
                  className={maximized ? 'i-mdi:window-restore' : 'i-mdi:window-maximize'}
                  aria-hidden
                />
              </button>
            </Tooltip>
            <Tooltip content="关闭主窗口">
              <button
                type="button"
                className="ema-main-window-close"
                aria-label="关闭主窗口"
                onClick={() => runWindowAction(() => tauriBridge.hideMainWindow())}
              >
                <span className="i-lucide:x" aria-hidden />
              </button>
            </Tooltip>
          </div>
        </header>
        <div className="ema-main-body" ref={imageViewerRoot}>
          <nav className="ema-main-rail" aria-label="主导航">
            <Tooltip content="聊天" side="right">
              <IconButton
                label="聊天"
                icon="i-lucide:house"
                variant="ghost"
                shape="rounded"
                toggled={activeView === MainView.Chat}
                aria-current={activeView === MainView.Chat ? 'page' : undefined}
                onClick={() => setActiveView(MainView.Chat)}
              />
            </Tooltip>
            <div className="flex-1" />
            <Tooltip content="设置" side="right">
              <IconButton
                label="设置"
                icon="i-lucide:settings"
                variant="ghost"
                shape="rounded"
                toggled={activeView === MainView.Settings}
                aria-current={activeView === MainView.Settings ? 'page' : undefined}
                onClick={() => setActiveView(MainView.Settings)}
              />
            </Tooltip>
          </nav>
          <div className="ema-main-views">
            {[...views].map(view => {
              const visible = activeView === view;
              let content: JSX.Element;
              switch (view) {
                case MainView.Chat:
                  content = (
                    <MarkdownMedia directory={cwd} onOpenFile={openFile} active={visible}>
                      <ChatPage />
                    </MarkdownMedia>
                  );
                  break;
                case MainView.Settings:
                  content = <SettingsPanel />;
                  break;
              }
              return (
                <div
                  key={view}
                  data-main-view={view}
                  data-active={visible}
                  className="ema-main-view"
                  aria-hidden={!visible}
                  ref={element => {
                    if (element) {
                      element.inert = !visible;
                    }
                  }}
                >
                  <Suspense
                    fallback={
                      <div className="flex h-full items-center justify-center text-[var(--ema-text-tertiary)]">
                        加载中…
                      </div>
                    }
                  >
                    {content}
                  </Suspense>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </ImageViewerProvider>
  );
}
