// 将统一按钮连接到原生文件选择框，并把选中的文件交给业务层。
import {
  Children,
  cloneElement,
  useRef,
  type ButtonHTMLAttributes,
  type ChangeEvent,
  type MouseEvent,
  type ReactElement,
} from 'react';
import { cn } from '../utils/cn.js';

// ── FilePicker ───────────────────────────────────────────────────────────────
//
// Hidden native <input type="file"> wrapped behind a trigger. Lets call sites
// avoid raw <input> (CLAUDE.md red line) while keeping the native file dialog.
// For directory picks or Tauri-managed dialogs, use tauriBridge.openFileDialog
// directly instead.

export interface FilePickerProps {
  /** accept attribute, e.g. "image/*", ".json,.csv". */
  accept?:    string;
  multiple?:  boolean;
  onSelect:   (files: File[]) => void;
  /** 单个按钮元素；FilePicker 只增强它，不会再额外包裹 button。 */
  children:   ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;
  className?: string;
  disabled?:  boolean;
}

export function FilePicker(props: FilePickerProps): React.JSX.Element {
  const { accept, multiple = false, onSelect, children, className, disabled } = props;
  const ref = useRef<HTMLInputElement>(null);
  const trigger = Children.only(children);
  const triggerDisabled = Boolean(disabled || trigger.props.disabled);

  const onChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) onSelect(files);
    e.target.value = '';
  };

  const onTriggerClick = (event: MouseEvent<HTMLButtonElement>): void => {
    trigger.props.onClick?.(event);
    if (event.defaultPrevented || triggerDisabled) return;
    ref.current?.click();
  };

  const enhancedTrigger = cloneElement(trigger, {
    type: trigger.props.type ?? 'button',
    disabled: triggerDisabled,
    className: cn(
      'inline-flex items-center justify-center',
      trigger.props.className,
      className,
    ),
    onClick: onTriggerClick,
  });

  return (
    <>
      {enhancedTrigger}
      <input
        ref={ref}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={triggerDisabled}
        className="hidden"
        onChange={onChange}
      />
    </>
  );
}
