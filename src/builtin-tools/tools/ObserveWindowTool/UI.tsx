import type { JSX } from 'react';
import { computerObservationSchema } from '@ema-agent/computer-use/types';

export function ObserveWindowResultView({ data, renderImage }: {
  readonly data: unknown;
  readonly renderImage: (image: { readonly src: string; readonly alt: string }) => JSX.Element;
}): JSX.Element | null {
  const parsed = computerObservationSchema.safeParse(data);
  if (!parsed.success) return null;
  const observation = parsed.data;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="text-sm">{observation.window.title || observation.window.app}</div>
      {renderImage({
        src: `data:${observation.mimeType};base64,${observation.image}`,
        alt: observation.window.title || '窗口观察',
      })}
      <details>
        <summary className="cursor-pointer text-sm">控件列表 ({observation.elements.length}){observation.truncated ? ' - 未全部读取' : ''}</summary>
        <div className="mt-2 max-h-64 overflow-auto text-xs">
          <table className="w-full text-left">
            <thead><tr><th>编号</th><th>类型</th><th>名称</th><th>状态</th></tr></thead>
            <tbody>
              {observation.elements.map(element => (
                <tr key={element.id}>
                  <td className="pr-3">{element.id}</td>
                  <td className="pr-3">{element.role}</td>
                  <td className="max-w-72 break-words pr-3">{element.name}</td>
                  <td>{element.enabled ? '可用' : '禁用'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
