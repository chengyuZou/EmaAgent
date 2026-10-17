import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { Button } from '@ema-agent/ui';
import { PageHeader } from '../shared/PageHeader.js';
import { MainView, useMainNavigationStore } from '../../layout/navigation.js';
import { sessionsApi, type SessionSummary } from '../../api/sessions.js';
import { showToast } from '../../lib/notifications/toast.js';
import { tauriBridge } from '../../lib/tauri/tauriBridge.js';
import { morphTransition, MORPH_NAME } from './viewTransition.js';
import { StorageList } from './components/list.js';
import { StorageDetail, type StorageDetailTarget } from './components/detail.js';
import { useStorageOverview } from './useStorageOverview.js';
import { useSessionDirectory } from './useSessionDirectory.js';
import { subscribeSystemEvent } from '../../lib/events/systemEventDispatcher.js';

export function StorageTab(): JSX.Element {
  const overview = useStorageOverview();
  const directory = useSessionDirectory();
  const active = useMainNavigationStore(state => state.activeView === MainView.Settings && state.settingsTab === 'storage');
  const [importing, setImporting] = useState(false);
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const [detail, setDetail] = useState<StorageDetailTarget | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const morphSource = useRef<HTMLElement | null>(null);
  const retry = useCallback(() => {
    overview.refresh();
    directory.refresh();
  }, [overview.refresh, directory.refresh]);

  const openDetail = useCallback((next: StorageDetailTarget, source: HTMLElement) => {
    morphSource.current = source;
    source.style.viewTransitionName = MORPH_NAME;
    // 旧画面给统计块命名, 新画面给详情命名. 同时存在两个同名元素会使过渡失败.
    void morphTransition(() => {
      source.style.viewTransitionName = '';
      setDetail(next);
    })?.catch(cause => console.warn('[storage] 打开详情过渡失败:', cause));
  }, []);

  const closeDetail = useCallback(() => {
    const source = morphSource.current;
    const finished = morphTransition(() => {
      setDetail(null);
      if (source) source.style.viewTransitionName = MORPH_NAME;
    });
    const cleanup = (): void => {
      if (source) source.style.viewTransitionName = '';
      morphSource.current = null;
    };
    if (!finished) {
      cleanup();
      return;
    }
    void finished.catch(cause => console.warn('[storage] 关闭详情过渡失败:', cause)).finally(cleanup);
  }, []);

  useEffect(() => subscribeSystemEvent(event => {
    if (event.type !== 'sessions_deleted') {
      return;
    }
    setOpenSessionId(current => {
      if (current !== null && event.sessionIds.includes(current)) {
        return null;
      }
      return current;
    });
    if (detail && event.sessionIds.includes(detail.sessionId)) {
      closeDetail();
    }
  }), [detail, closeDetail]);

  const importSession = useCallback(async (): Promise<void> => {
    if (!tauriBridge.isTauri()) {
      showToast('请在桌面窗口中选择会话备份文件', { variant: 'warning' });
      return;
    }
    setImporting(true);
    try {
      const filePath = await tauriBridge.openFileDialog({
        title: '导入会话备份',
        filters: [{ name: '会话备份 ZIP', extensions: ['zip'] }],
      });
      // 取消文件选择不是导入失败, 也不发送请求.
      if (filePath === null) {
        return;
      }
      const result = await sessionsApi.importSession(filePath);
      showToast(
        result.warnings.length > 0
          ? `会话已导入，有 ${result.warnings.length} 项提示: ${result.warnings[0]}`
          : '会话导入成功',
        { variant: result.warnings.length > 0 ? 'warning' : 'success' },
      );
    } catch (cause) {
      showToast(cause instanceof Error ? `导入失败: ${cause.message}` : '导入失败', { variant: 'danger' });
    } finally {
      setImporting(false);
    }
  }, []);

  const exportSession = useCallback((session: SessionSummary) => {
    if (!tauriBridge.isTauri()) {
      showToast('请在桌面窗口中选择备份保存位置', { variant: 'warning' });
      return;
    }
    setExporting(session.id);
    void (async () => {
      try {
        const filename = (session.title || 'session').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
        const destinationPath = await tauriBridge.saveFileDialog({
          title: '导出会话备份',
          defaultPath: `${filename}.ema-session.zip`,
          filters: [{ name: '会话备份 ZIP', extensions: ['zip'] }],
        });
        if (destinationPath === null) {
          return;
        }
        const result = await sessionsApi.exportSession(session.id, destinationPath);
        const saved = `会话已保存到 ${result.filePath}`;
        showToast(
          result.warnings.length > 0
            ? `${saved}，有 ${result.warnings.length} 个文件未包含在备份中`
            : saved,
          { variant: result.warnings.length > 0 ? 'warning' : 'success', duration: 6000 },
        );
      } catch (cause) {
        showToast(cause instanceof Error ? `导出失败: ${cause.message}` : '导出失败', { variant: 'danger' });
      } finally {
        setExporting(null);
      }
    })();
  }, []);

  const toggleSession = useCallback((sessionId: string) => {
    setOpenSessionId(current => current === sessionId ? null : sessionId);
  }, []);

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <div
        className={`shrink-0 border-b border-[var(--ema-border)] px-6 pt-5 ${detail ? 'invisible' : ''}`}
        aria-hidden={detail !== null}
        {...(detail ? { inert: '' } : {})}
      >
        <PageHeader
          title="存储位置"
          description="会话与数据存储，~/.ema-agent/data"
          action={(
            <Button
              variant="secondary"
              size="sm"
              loading={importing}
              disabled={exporting !== null}
              onClick={() => void importSession()}
            >
              <span className="i-solar:upload-minimalistic-bold-duotone" aria-hidden />导入会话
            </Button>
          )}
        />
      </div>
      {/* 概览保留滚动位置. 详情只挂载当前类别, 返回后释放详情正文和播放器. */}
      <div
        className={`ema-fade-in min-h-0 flex-1 overflow-y-auto p-6 ${detail ? 'invisible' : ''}`}
        aria-hidden={detail !== null}
        {...(detail ? { inert: '' } : {})}
      >
        <StorageList
          stats={overview.stats}
          sessions={directory.sessions}
          loading={directory.loading}
          error={directory.error ?? overview.error}
          onRetry={retry}
          openSessionId={openSessionId}
          exportingSessionId={exporting}
          exportDisabled={importing || exporting !== null}
          onToggle={toggleSession}
          onExport={exportSession}
          onOpenDetail={openDetail}
        />
      </div>
      {detail && (
        <StorageDetail
          key={`${detail.sessionId}:${detail.kind}`}
          target={detail}
          active={active}
          onClose={closeDetail}
        />
      )}
    </div>
  );
}
