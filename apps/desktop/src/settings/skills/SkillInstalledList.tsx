// 已安装技能列表:启停、查看内容与卸载入口,内含 SKILL.md 预览对话框。
import { useState, type CSSProperties, type JSX } from 'react';
import {
  Badge, Button, Card, Dialog, EmptyState, ScrollArea, Spinner, Switch, Tooltip,
} from '@ema-agent/ui';
import { useSkillStore } from '../../stores/skill.js';
import { skillsApi } from '../../api/skills.js';
import { showToast } from '../../lib/toast.js';
import { Markdown } from '../../markdown/renderer.js';

const SCOPE_LABEL: Record<string, string> = {
  builtin: '内置',
  user:    '用户',
  project: '项目',
};

export function SkillInstalledList({
  onRemove,
}: {
  onRemove: (key: string) => void;
}): JSX.Element {
  const skills  = useSkillStore((s) => s.skills);
  const loading = useSkillStore((s) => s.loading);

  const [viewing, setViewing]   = useState<string | null>(null);
  const [content, setContent]   = useState<string | null>(null);
  const [viewLoading, setViewLoading] = useState(false);

  async function handleView(key: string): Promise<void> {
    setViewing(key);
    setContent(null);
    setViewLoading(true);
    try {
      const res = await skillsApi.getContent(key);
      setContent(res.content);
    } catch (err) {
      showToast(`读取失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
      setViewing(null);
    } finally {
      setViewLoading(false);
    }
  }

  if (loading) {
    return <div className="flex justify-center py-10"><Spinner size="md" /></div>;
  }

  if (skills.length === 0) {
    return (
      <EmptyState icon="i-mdi:puzzle-outline" title="暂无已安装技能" hint="切换到「浏览市场」安装" className="py-16" />
    );
  }

  return (
    <ScrollArea className="flex-1" viewportClassName="pb-2">
      <div className="flex flex-col gap-2 pr-2">
        {skills.map((sk, i) => (
          <Card
            key={sk.key}
            variant="elevated"
            padding="sm"
            className="ema-stagger-in active:scale-[0.98] transition-all duration-[var(--ema-duration-base)] ema-card-decorate ema-card-decorate--diamond"
            style={{ '--stagger-i': i } as CSSProperties}
          >
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-[var(--ema-text-primary)]">{sk.name}</span>
                  <Badge variant="neutral">v{sk.version}</Badge>
                  <Badge variant="neutral">{SCOPE_LABEL[sk.scope] ?? sk.scope}</Badge>
                </div>
                {sk.description && (
                  <p className="text-xs text-[var(--ema-text-tertiary)] mt-1 line-clamp-2">{sk.description}</p>
                )}
              </div>

              <div className="flex items-center gap-3 shrink-0 pt-0.5">
                <Tooltip content="查看内容">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-primary)] px-1.5"
                    onClick={() => void handleView(sk.key)}
                  >
                    <span className="i-mdi:eye-outline text-base" aria-hidden />
                  </Button>
                </Tooltip>
                <Tooltip content={sk.enabled ? '禁用技能' : '启用技能'}>
                  <Switch
                    checked={sk.enabled}
                    label={sk.name}
                    onCheckedChange={(checked) => {
                      void useSkillStore.getState()
                        .setEnabled(sk.key, checked)
                        .catch((err: Error) => showToast(`更新失败: ${err.message}`, { variant: 'danger' }));
                    }}
                  />
                </Tooltip>
                {sk.scope === 'user' && (
                  <Tooltip content="卸载技能">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-[var(--ema-text-tertiary)] hover:text-[var(--ema-danger)] px-1.5"
                      onClick={() => onRemove(sk.key)}
                    >
                      <span className="i-mdi:delete-outline text-base" aria-hidden />
                    </Button>
                  </Tooltip>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* Skill content viewer */}
      <Dialog
        open={viewing !== null}
        onOpenChange={(open) => { if (!open) { setViewing(null); setContent(null); } }}
        title={viewing ? `${viewing} · SKILL.md` : '技能内容'}
        description="技能定义的完整内容（含 frontmatter）"
        widthClass="max-w-3xl"
      >
        {viewLoading ? (
          <div className="flex justify-center py-12"><Spinner size="md" /></div>
        ) : (
          <div className="max-h-[60vh] overflow-auto rounded-lg p-3 selectable
                          bg-[var(--ema-surface-0)] border border-[var(--ema-border)]">
            <Markdown source={content ?? ''} />
          </div>
        )}
      </Dialog>
    </ScrollArea>
  );
}
