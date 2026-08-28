// 展示本机磁盘与系统事件连接状态，并支持刷新与复制报告。
//
// TODO(K3)：全局 diagnostics-store 已删除（唯一页面消费，不需要全局 Store），
// 状态改由本组件本地化：磁盘信息走 systemApi.getInfo()、事件连接状态走
// systemApi.eventsDiagnostics()，报告格式由本组件内联。

import type { JSX } from 'react';
import { EmptyState } from '@ema-agent/ui';

export function DiagnosticsTab(): JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 pb-8">
      <header>
        <h1 className="text-xl font-semibold text-[var(--ema-text-primary)]">系统诊断</h1>
        <p className="mt-1 text-sm text-[var(--ema-text-tertiary)]">
          查看本机存储与事件连接状态，便于定位运行异常。
        </p>
      </header>
      <EmptyState
        icon="i-lucide:hard-drive"
        title="诊断面板待重建"
        hint="TODO(K3)：接 systemApi.getInfo() 与 eventsDiagnostics() 后在本地渲染。"
        className="py-16"
      />
    </div>
  );
}
