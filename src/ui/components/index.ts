// ── @ema-agent/ui component barrel ──────────────────────────────────────────

// Primitives
export { Button }     from './Button.js';
export { IconButton } from './IconButton.js';
export { Input }      from './Input.js';
export { Textarea }   from './Textarea.js';
export { Card }       from './Card.js';
export { CardButton } from './CardButton.js';
export { StatCard }  from './StatCard.js';
export { EmptyState } from './EmptyState.js';
export { ToolSpecItem } from './ToolSpecItem.js';
export { RadioDot } from './RadioDot.js';
export { MarketCard } from './MarketCard.js';
export { EntityRow } from './EntityRow.js';

// Feedback
export { Skeleton } from './Skeleton.js';
export { Spinner }  from './Spinner.js';
export { Callout }  from './Callout.js';
export { Progress } from './Progress.js';

// Indicators
export { Badge }   from './Badge.js';
export { Divider } from './Divider.js';

// Menu cards (AIRI-style settings entries)
export { MenuIconItem }   from './MenuIconItem.js';
export { MenuStatusItem } from './MenuStatusItem.js';

// Layout / overlays
export { Dialog }        from './Dialog.js';
export { ConfirmDialog } from './ConfirmDialog.js';
export { PromptDialog }  from './PromptDialog.js';
export { Popover }      from './Popover.js';
export { Tooltip, TooltipProvider } from './Tooltip.js';
export { DropdownMenu } from './DropdownMenu.js';
export { Select }       from './Select.js';
export { Combobox }     from './Combobox.js';
export { Tabs }         from './Tabs.js';
export { ScrollArea }   from './ScrollArea.js';

// Form controls
export { Field }    from './Field.js';
export { Switch }   from './Switch.js';
export { Slider }   from './Slider.js';
export { Checkbox }  from './Checkbox.js';
export { FilePicker } from './FilePicker.js';

// Notifications
export { Toaster, toast } from './Toast.js';

// Types
export type { ButtonProps, ButtonVariant, ButtonSize, ButtonShape } from './Button.js';
export type { IconButtonProps, IconButtonVariant, IconButtonSize } from './IconButton.js';
export type { InputProps, InputSize } from './Input.js';
export type { TextareaProps, TextareaHandle } from './Textarea.js';
export type { CardProps, CardVariant, CardPadding } from './Card.js';
export type { CardButtonProps, CardButtonPadding } from './CardButton.js';
export type { StatCardProps } from './StatCard.js';
export type { EmptyStateProps } from './EmptyState.js';
export type { ToolSpecItemProps } from './ToolSpecItem.js';
export type { RadioDotProps } from './RadioDot.js';
export type { MarketCardProps } from './MarketCard.js';
export type { EntityRowProps } from './EntityRow.js';
export type { SkeletonProps, SkeletonAnimation } from './Skeleton.js';
export type { SpinnerProps, SpinnerSize } from './Spinner.js';
export type { CalloutProps, CalloutVariant } from './Callout.js';
export type { ProgressProps } from './Progress.js';
export type { BadgeProps, BadgeVariant } from './Badge.js';
export type { DividerProps } from './Divider.js';
export type { MenuIconItemProps } from './MenuIconItem.js';
export type { MenuStatusItemProps } from './MenuStatusItem.js';
export type { DialogProps } from './Dialog.js';
export type { ConfirmDialogProps } from './ConfirmDialog.js';
export type { PromptDialogProps } from './PromptDialog.js';
export type { PopoverProps } from './Popover.js';
export type { TooltipProps } from './Tooltip.js';
export type { DropdownMenuProps, MenuItem } from './DropdownMenu.js';
export type { SelectProps, SelectOption } from './Select.js';
export type { ComboboxProps, ComboboxOption } from './Combobox.js';
export type { TabsProps, TabItem } from './Tabs.js';
export type { ScrollAreaProps } from './ScrollArea.js';
export type { FieldProps } from './Field.js';
export type { SwitchProps } from './Switch.js';
export type { SliderProps, SliderStep } from './Slider.js';
export type { CheckboxProps } from './Checkbox.js';
export type { FilePickerProps } from './FilePicker.js';
export type { ToasterProps, ToastItem, ToastVariant } from './Toast.js';
