import { useState, useEffect, type ChangeEvent } from 'react';
import { Dialog } from './Dialog.js';
import { Input } from './Input.js';
import { Button } from './Button.js';

// ── PromptDialog ─────────────────────────────────────────────────────────────
//
// Single-line input modal. Replaces native prompt(). Built on Dialog + Input +
// Button (all token-driven, light/dark safe). Esc / overlay-click = cancel.
// Enter = confirm.

export interface PromptDialogProps {
  open:         boolean;
  /** Dialog title. Defaults to "请输入". */
  title?:       string;
  /** Prompt message above the input. */
  message:      string;
  /** Initial input value (restored each time the dialog opens). */
  initialValue?: string;
  placeholder?: string;
  confirmText?: string;
  cancelText?:  string;
  onConfirm:    (value: string) => void;
  onCancel:     () => void;
}

export function PromptDialog(props: PromptDialogProps): React.JSX.Element {
  const {
    open, title, message, initialValue = '', placeholder,
    confirmText = '确认', cancelText = '取消',
    onConfirm, onCancel,
  } = props;
  const [value, setValue] = useState(initialValue);

  // Reset to initialValue each time the dialog opens.
  useEffect(() => { if (open) setValue(initialValue); }, [open, initialValue]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()} title={title ?? '请输入'} hideClose>
      <p className="text-sm text-[var(--ema-text-secondary)] mb-3">{message}</p>
      <Input
        value={value}
        placeholder={placeholder}
        autoFocus
        onKeyDown={(e) => { if (e.key === 'Enter') onConfirm(value); }}
        onChange={(e: ChangeEvent<HTMLInputElement>) => setValue(e.target.value)}
      />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>{cancelText}</Button>
        <Button variant="primary" onClick={() => onConfirm(value)}>{confirmText}</Button>
      </div>
    </Dialog>
  );
}
