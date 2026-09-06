// 存储库删除对话框:确认双档(只删注册/全部删除),忙碌与最后一个只给信息版。
import { useState, type JSX } from 'react';
import { Button, Callout, Dialog } from '@ema-agent/ui';
import { ServerApiError } from '../../api/client.js';
import type { DataDirItem } from '../../api/workspaces.js';
import { useStorageStore } from '../../stores/storage.js';
import { showToast } from '../../lib/toast.js';

type Mode =
  | { kind: 'confirm' }
  | { kind: 'busy' }
  | { kind: 'last' }
  | { kind: 'leftovers'; leftovers: string[] };

export function DeleteDirDialog({
  dir,
  open,
  onOpenChange,
}: {
  dir: DataDirItem | null;
  open: boolean;
  onOpenChange(v: boolean): void;
}): JSX.Element {
  const [mode, setMode] = useState<Mode>({ kind: 'confirm' });
  const [working, setWorking] = useState<'registry' | 'wipe' | null>(null);
  const store = useStorageStore();

  function close(): void {
    setMode({ kind: 'confirm' });
    onOpenChange(false);
  }

  async function handleDelete(wipe: boolean): Promise<void> {
    if (!dir) return;
    setWorking(wipe ? 'wipe' : 'registry');
    try {
      const result = await store.removeDir(dir.name, wipe);
      const leftovers = result.wipe?.leftovers ?? [];
      if (wipe && leftovers.length > 0) {
        setMode({ kind: 'leftovers', leftovers });
      } else {
        showToast(wipe ? '存储库已删除' : '已移除注册(文件未删除)', { variant: 'success' });
        if (result.restartRequired) {
          showToast('活动库已切换,请重启应用生效', { variant: 'warning' });
        }
        close();
      }
    } catch (error) {
      if (error instanceof ServerApiError && error.code === 'dir_busy') {
        setMode({ kind: 'busy' });
      } else if (error instanceof ServerApiError && error.code === 'cannot_remove_last') {
        setMode({ kind: 'last' });
      } else {
        showToast(error instanceof Error ? error.message : '删除失败', { variant: 'danger' });
        close();
      }
    } finally {
      setWorking(null);
    }
  }

  if (!dir) return <></>;

  if (mode.kind === 'busy') {
    return (
      <Dialog open={open} onOpenChange={close} title="暂时无法删除" widthClass="max-w-md">
        <div className="flex flex-col gap-4 pt-1">
          <p className="text-sm text-[var(--ema-text-secondary)]">
            存储库「{dir.name}」是当前活动库,且有正在进行的任务。请等任务结束或手动停止后再删除——本业务不负责替你收拾正在跑的东西。
          </p>
          <div className="flex justify-end">
            <Button variant="primary" onClick={close}>好的</Button>
          </div>
        </div>
      </Dialog>
    );
  }

  if (mode.kind === 'last') {
    return (
      <Dialog open={open} onOpenChange={close} title="无法删除" widthClass="max-w-md">
        <div className="flex flex-col gap-4 pt-1">
          <p className="text-sm text-[var(--ema-text-secondary)]">
            「{dir.name}」是仅剩的存储库,至少需要保留一个。
          </p>
          <div className="flex justify-end">
            <Button variant="primary" onClick={close}>好的</Button>
          </div>
        </div>
      </Dialog>
    );
  }

  if (mode.kind === 'leftovers') {
    return (
      <Dialog open={open} onOpenChange={close} title="已删除 Ema 数据" widthClass="max-w-md">
        <div className="flex flex-col gap-4 pt-1">
          <p className="text-sm text-[var(--ema-text-secondary)]">
            Ema 的数据已删除,但目录内还有不属于 Ema 的文件,未动:
          </p>
          <Callout variant="warn" className="text-xs font-mono">
            {mode.leftovers.join('、')}
          </Callout>
          <div className="flex justify-end">
            <Button variant="primary" onClick={close}>好的</Button>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={`删除存储库「${dir.name}」`}
      description={dir.path}
      widthClass="max-w-md"
    >
      <div className="flex flex-col gap-4 pt-1">
        <p className="text-sm text-[var(--ema-text-secondary)]">
          「只删注册」仅从列表移除,磁盘数据原样保留;「全部删除」会清掉 Ema 在该目录下的全部数据(data.db、sessions、audio),目录里不属于 Ema 的文件不会动。
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>取消</Button>
          <Button
            variant="ghost"
            loading={working === 'registry'}
            onClick={() => void handleDelete(false)}
          >
            只删注册
          </Button>
          <Button
            variant="danger"
            loading={working === 'wipe'}
            onClick={() => void handleDelete(true)}
          >
            全部删除
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
