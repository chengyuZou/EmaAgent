import type { AttachmentBlock, SkillReferenceBlock } from '@ema-agent/session';
import type { ChatDraftReference } from '../../stores/chatDraft.js';

interface AttachmentLabel {
  readonly label: string;
  readonly detail: string;
  readonly icon: string;
  readonly color: string;
}

export function attachmentLabel(
  reference: ChatDraftReference | AttachmentBlock | SkillReferenceBlock,
): AttachmentLabel {
  if (reference.type === 'skill_reference') {
    return {
      label: reference.name,
      detail: `技能: ${reference.name}\n${reference.path}`,
      icon: 'i-lucide:sparkles',
      color: 'var(--ema-primary-text)',
    };
  }
  if (reference.type === 'pasted_text' || reference.type === 'pasted_text_reference') {
    return {
      label: '粘贴文本',
      detail: reference.preview,
      icon: 'i-lucide:clipboard-paste',
      color: 'var(--ema-warning)',
    };
  }
  if (reference.type === 'image' || reference.type === 'image_reference') {
    const name = reference.name ?? '图片';
    return {
      label: name,
      detail: name,
      icon: 'i-mdi:image-outline',
      color: 'var(--ema-file-image)',
    };
  }

  const name = reference.path.split(/[\\/]/).pop() ?? reference.path;
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  let icon = 'i-lucide:paperclip';
  let color = 'var(--ema-file-other)';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension)) {
    icon = 'i-mdi:image-outline';
    color = 'var(--ema-file-image)';
  } else if (extension === 'pdf') {
    icon = 'i-mdi:file-pdf-box';
    color = 'var(--ema-file-pdf)';
  } else if (['doc', 'docx'].includes(extension)) {
    icon = 'i-mdi:file-word';
    color = 'var(--ema-file-word)';
  } else if (['ppt', 'pptx'].includes(extension)) {
    icon = 'i-mdi:file-powerpoint';
    color = 'var(--ema-file-ppt)';
  } else if (['xls', 'xlsx'].includes(extension)) {
    icon = 'i-mdi:file-excel';
    color = 'var(--ema-file-excel)';
  } else if (/^(ts|tsx|js|jsx|html|css|md|json|py|rs|go|cpp|c|java|rb|php|sh|yaml|yml|toml|sql)$/.test(extension)) {
    icon = 'i-mdi:file-code-outline';
    color = 'var(--ema-file-code)';
  }
  return { label: name, detail: reference.path, icon, color };
}
