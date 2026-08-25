import { useState, type JSX } from 'react';
import {
  Badge, Button, Callout, Divider, Field,
  Input, ScrollArea, Switch
} from '@ema-agent/ui';
import { useMemoryStore } from '../../stores/memory-store.js';
import { showToast } from '../../lib/toast.js';
import { NODE_TYPE_LABEL, NODE_TYPE_VARIANT } from './memoryLabels.js';


export function MaintenanceTab(): JSX.Element {
  const maintenanceRunning = useMemoryStore((s) => s.maintenanceRunning);
  const maintenanceReport  = useMemoryStore((s) => s.maintenanceReport);
  const maintenanceError   = useMemoryStore((s) => s.maintenanceError);

  const [decayAfterDays, setDecayAfterDays] = useState('30');
  const [decayAmount,    setDecayAmount]    = useState('10');
  const [decayItems,     setDecayItems]     = useState(true);
  const [dryRun,         setDryRun]         = useState(true);

  async function runMaintenance(): Promise<void> {
    try {
      await useMemoryStore.getState().runMaintenance({
        decayAfterDays: Number(decayAfterDays) || 30,
        decayAmount:    Number(decayAmount)    || 10,
        decayItems,
        dryRun,
      });
      showToast(dryRun ? '预演完成，查看下方结果' : '维护完成', { variant: 'success' });
    } catch {
      // error shown via maintenanceError
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="ema-slide-down">
        <h3 className="text-sm font-semibold text-[var(--ema-text-primary)]">重要度衰减</h3>
        <p className="text-xs font-semibold text-[var(--ema-text-tertiary)] mt-0.5">
          降低长期未引用记忆的重要度，使其在召回时权重降低。受保护类型(事实/偏好/关系)永远不衰减。
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 ema-slide-up">
        <Field label="衰减阈值(天)" description="最后引用距今超过此天数才会衰减">
          <Input
            type="number"
            min="1"
            value={decayAfterDays}
            onChange={(e) => setDecayAfterDays(e.target.value)}
          />
        </Field>

        <Field label="单次衰减量" description="每次执行将重要度减少(0–100)">
          <Input
            type="number"
            min="0"
            max="100"
            step="1"
            value={decayAmount}
            onChange={(e) => setDecayAmount(e.target.value)}
          />
        </Field>
      </div>

      <div className="flex items-center gap-6">
        <div className="flex items-center gap-3">
          <Switch
            checked={decayItems}
            label="同时衰减条目"
            showLabel
            onCheckedChange={setDecayItems}
          />
        </div>
        <div className="flex items-center gap-3">
          <Switch
            checked={dryRun}
            label="预演模式(不实际修改)"
            showLabel
            onCheckedChange={setDryRun}
          />
        </div>
      </div>

      {maintenanceError && (
        <Callout variant="danger">{maintenanceError}</Callout>
      )}

      <div>
        <Button
          variant={dryRun ? 'secondary' : 'danger'}
          size="sm"
          loading={maintenanceRunning}
          disabled={maintenanceRunning}
          onClick={() => void runMaintenance()}
        >
          {dryRun ? '预演衰减' : '执行衰减'}
        </Button>
      </div>

      {/* Report */}
      {maintenanceReport && (
        <>
          <Divider />
          <div>
            <div className="flex items-center gap-2 mb-3">
              <p className="text-sm font-semibold text-[var(--ema-text-primary)]">执行结果</p>
              {maintenanceReport.dryRun && <Badge variant="warn">预演</Badge>}
              <span className="text-xs font-semibold text-[var(--ema-text-tertiary)]">
                衰减节点 {maintenanceReport.decayedNodes}，衰减条目 {maintenanceReport.decayedItems}
              </span>
            </div>

            {maintenanceReport.preview.nodes.length > 0 && (
              <div className="mb-3">
                <p className="text-xs font-semibold text-[var(--ema-text-tertiary)] mb-1.5">受影响节点(前 {maintenanceReport.preview.nodes.length} 条)</p>
                <ScrollArea viewportClassName="max-h-40">
                  <div className="flex flex-col gap-1 pr-1">
                    {maintenanceReport.preview.nodes.map((n) => (
                      <div key={n.id} className="flex items-center gap-2 text-xs">
                        <Badge variant={NODE_TYPE_VARIANT[n.nodeType]}>{NODE_TYPE_LABEL[n.nodeType]}</Badge>
                        <span className="flex-1 truncate font-semibold text-[var(--ema-text-secondary)]">{n.label}</span>
                        <span className="font-semibold text-[var(--ema-text-tertiary)] opacity-60 tabular-nums shrink-0">
                          {(n.currentImportance * 100).toFixed(0)}% → {(n.newImportance * 100).toFixed(0)}%
                        </span>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            )}

            {maintenanceReport.preview.items.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-[var(--ema-text-tertiary)] mb-1.5">受影响条目(前 {maintenanceReport.preview.items.length} 条)</p>
                <ScrollArea viewportClassName="max-h-40">
                  <div className="flex flex-col gap-1 pr-1">
                    {maintenanceReport.preview.items.map((item) => (
                      <div key={item.id} className="flex items-center gap-2 text-xs">
                        <span className="flex-1 truncate font-semibold text-[var(--ema-text-secondary)]">{item.title}</span>
                        <span className="font-semibold text-[var(--ema-text-tertiary)] opacity-60 tabular-nums shrink-0">
                          {(item.currentImportance * 100).toFixed(0)}% → {(item.newImportance * 100).toFixed(0)}%
                        </span>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            )}

            {maintenanceReport.preview.nodes.length === 0 && maintenanceReport.preview.items.length === 0 && (
              <p className="text-xs font-semibold text-[var(--ema-text-tertiary)] opacity-40">此次无需衰减的记忆</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
