import { lazy, Suspense, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Button, DropdownMenu, IconButton, Tooltip, type MenuItem } from '@ema-agent/ui';
import { ChatPage } from '../chat/ChatPage.js';
import { subscribeSystemEvent } from '../lib/system-event-dispatcher.js';
import { mountSystemEvents } from '../lib/system-sse.js';
import { tauriBridge } from '../lib/tauri-bridge.js';
import { showToast } from '../lib/toast.js';
import { ImageViewerProvider } from '../lib/images/imageViewer.js';
import { MarkdownImages } from '../lib/images/markdownImages.js';
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

const SettingsPanel = lazy(async () => {
  const module = await import('../settings/SettingsPanel.js');
  return { default: module.SettingsPanel };
});

export function MainWindow(): JSX.Element {
  const activeView = useMainNavigationStore(state => state.activeView);
  const sessionId = useMainNavigationStore(state => state.viewedSessionId);
  const cwd = useSessionStore(state => state.sessions.byId.get(sessionId ?? '')?.cwd);
  const openWorkspaceFile = useSessionPanelStore(state => state.openWorkspaceFile);
  const openImageFile = useMemo(() => {
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
  useSettingsSync(serverReady);
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
                    <MarkdownImages directory={cwd} onOpenFile={openImageFile}>
                      <ChatPage />
                    </MarkdownImages>
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
