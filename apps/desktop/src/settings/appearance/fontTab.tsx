import type { JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Select, type SelectOption } from '@ema-agent/ui';
import { useThemeStore } from '../../stores/theme.js';
import { PageHeader } from '../shared/PageHeader.js';

// Radix 保留空字符串用于清空选择, 系统默认选项在保存时转换回空字符串.
const SYSTEM_FONT_VALUE = '__system__';

function FontFamilyField({ family, systemLabel, systemFonts, onSave, onLazyLoad }: {
  family: string;
  systemLabel: string;
  systemFonts: string[];
  onSave(family: string): void;
  onLazyLoad(): void;
}): JSX.Element {
  const known = family === '' || systemFonts.includes(family);
  const selectOptions: SelectOption[] = [
    { value: SYSTEM_FONT_VALUE, label: systemLabel },
    ...(known ? [] : [{ value: family, label: `${family}(本机未安装)` }]),
    ...systemFonts.map((name, index) => ({
      value: name,
      label: name,
      ...(index === 0 ? { separatorAbove: true } : {}),
    })),
  ];

  return (
    <div
      onPointerDownCapture={onLazyLoad}
      onFocusCapture={onLazyLoad}
    >
      <Select
        value={family === '' ? SYSTEM_FONT_VALUE : family}
        onChange={value => onSave(value === SYSTEM_FONT_VALUE ? '' : value)}
        options={selectOptions}
      />
    </div>
  );
}

export function FontTab(): JSX.Element {
  const {
    readingFont,
    codeFont,
    systemFonts,
    ensureSystemFonts,
    setReadingFont,
    setCodeFont,
  } = useThemeStore(useShallow(state => ({
    readingFont: state.readingFont,
    codeFont: state.codeFont,
    systemFonts: state.systemFonts,
    ensureSystemFonts: state.ensureSystemFonts,
    setReadingFont: state.setReadingFont,
    setCodeFont: state.setCodeFont,
  })));

  return (
    <div className="mx-auto flex w-full flex-col gap-5">
      <PageHeader
        title="字体"
        description="Markdown 正文字体与代码等宽字体"
      />
      <section className="ema-material-section rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] p-5 space-y-4">
        <div>
          <p className="text-sm font-medium text-[var(--ema-text-secondary)]">
            Markdown 正文字体
          </p>
          <p className="text-xs mt-0.5 text-[var(--ema-text-tertiary)]">
            调整聊天正文和长文本的阅读观感，代码仍使用等宽字体
          </p>
        </div>
        <FontFamilyField
          family={readingFont}
          systemLabel="跟随系统"
          systemFonts={systemFonts}
          onSave={value => void setReadingFont(value)}
          onLazyLoad={() => void ensureSystemFonts()}
        />
        <div className="ema-material-reading markdown-content rounded-lg border border-[var(--ema-border)] bg-[var(--ema-surface-1)] px-4 py-3 text-sm text-[var(--ema-text-primary)]">
          Ema 会用这种字体显示 Markdown 正文。The quick brown fox jumps over the lazy dog.
        </div>
      </section>
      <section className="ema-material-section rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] p-5 space-y-4">
        <div>
          <p className="text-sm font-medium text-[var(--ema-text-secondary)]">
            等宽字体
          </p>
          <p className="text-xs mt-0.5 text-[var(--ema-text-tertiary)]">
            代码块、工具参数和终端使用的字体，界面其余部分不受影响
          </p>
        </div>
        <FontFamilyField
          family={codeFont}
          systemLabel="跟随系统等宽"
          systemFonts={systemFonts}
          onSave={value => void setCodeFont(value)}
          onLazyLoad={() => void ensureSystemFonts()}
        />
        <div className="ema-material-reading rounded-lg border border-[var(--ema-border)] bg-[var(--ema-surface-1)] px-4 py-3 font-mono text-xs text-[var(--ema-text-secondary)]">
          const ema = '代码 / JSON / 终端用这种字体显示'; // 0123456789
        </div>
      </section>
    </div>
  );
}
