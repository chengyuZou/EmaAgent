// 立绘只读网格:主窗口降级链的立绘候选;缩略图经认证请求取回,停用项显示占位。
import { useEffect, useState, type JSX } from 'react';
import { Badge, EmptyState } from '@ema-agent/ui';
import type { Character } from '../../../api/characters.js';
import { serverClient } from '../../../api/client.js';
import { PrimaryBadge } from '../shared/ResourceControls.js';

export function IllustrationTab({ character }: { character: Character }): JSX.Element {
  const [sources, setSources] = useState<Record<string, string>>({});

  // 展示顺序与服务端降级链一致:主用优先,其余按创建先后。
  const illustrations = [...character.illustrations].sort((a, b) =>
    Number(b.isPrimary) - Number(a.isPrimary) || a.createdAt - b.createdAt,
  );

  // 缩略图:文件流路由与所有 /api 路由一样要共享密钥,<img> 直链会被 401,
  // 因此逐张 fetch 成 blob 再转 objectURL;卸载时统一 revoke。
  useEffect(() => {
    let disposed = false;
    const created: string[] = [];
    void (async () => {
      const headers = await serverClient.getAuthHeaders();
      const map: Record<string, string> = {};
      for (const item of character.illustrations) {
        if (!item.enabled) continue;
        try {
          const url = await serverClient.streamUrl(
            `/api/characters/${character.id}/illustrations/${item.id}/file`,
          );
          const res = await fetch(url, { headers });
          if (!res.ok) continue;
          const objectUrl = URL.createObjectURL(await res.blob());
          created.push(objectUrl);
          map[item.id] = objectUrl;
        } catch {
          // 单张失败只损失该缩略图,不阻断列表。
        }
      }
      if (!disposed) setSources(map);
    })();
    return () => {
      disposed = true;
      for (const objectUrl of created) URL.revokeObjectURL(objectUrl);
    };
  }, [character]);

  return (
    <div className="pt-3">
      <p className="text-xs text-[var(--ema-text-tertiary)] mb-3">
        没有可用 Live2D 时,主窗口按 主用 → 创建先后 使用立绘。
      </p>

      {illustrations.length === 0 ? (
        <EmptyState
          icon="i-mdi:image-multiple-outline"
          title="暂无立绘"
          hint="该角色未附带立绘"
          className="py-12"
        />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
          {illustrations.map((p) => (
            <div
              key={p.id}
              className="rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] overflow-hidden"
            >
              <div className="aspect-[3/4] flex items-center justify-center bg-[var(--ema-surface-0)]">
                {sources[p.id] ? (
                  <img
                    src={sources[p.id]}
                    alt={p.name}
                    className="w-full h-full object-cover"
                    draggable={false}
                  />
                ) : (
                  <span className="i-mdi:image-off-outline text-2xl text-[var(--ema-text-tertiary)]" aria-hidden />
                )}
              </div>
              <div className="p-2.5">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs font-semibold text-[var(--ema-text-primary)] truncate">{p.name}</span>
                  <PrimaryBadge isPrimary={p.isPrimary} />
                  {!p.enabled && <Badge variant="warn">已停用</Badge>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
