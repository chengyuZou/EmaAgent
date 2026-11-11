import { useState, type CSSProperties, type JSX } from 'react';
import { IconButton, Textarea, Tooltip } from '@ema-agent/ui';
import microphoneIcon from '../../assets/icons/microphone.svg';
import discardIcon from '../../assets/icons/discard.svg';
import { tauriBridge } from '../../lib/tauri/tauriBridge.js';
import { useStageVoiceInput } from './useStageVoiceInput.js';

interface StageVoiceInputProps {
  readonly suspended: boolean;
}

const listeningLabels = {
  off: '未监听', starting: '正在开启', listening: '监听中',
};

function VoiceIcon({ url }: { readonly url: string }): JSX.Element {
  return <span className="ema-stage-voice-icon" style={{ '--ema-stage-voice-icon': `url("${url}")` } as CSSProperties} aria-hidden />;
}

export function StageVoiceInput({ suspended }: StageVoiceInputProps): JSX.Element | null {
  const [isExpanded, setIsExpanded] = useState(false);
  const {
    listeningStatus, sessionTitle, draftText, isSending, canSend,
    toggleListening, editDraft, clearDraft, sendDraft,
  } = useStageVoiceInput({ suspended });

  if (suspended || !tauriBridge.isTauri()) return null;
  const microphoneLabel = listeningStatus === 'off' ? '开启监听' : '停止监听';

  return (
    <div className="ema-stage-voice-input" data-tauri-drag-region="false">
      {isExpanded && (
        <section className="ema-stage-voice-panel ema-stage-surface" data-pet-interactive aria-label="麦克风输入">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">麦克风 · {listeningLabels[listeningStatus]}</span>
            <IconButton
              label="收起麦克风面板"
              icon="i-lucide:chevron-down"
              size="sm"
              variant="ghost"
              onClick={() => setIsExpanded(false)}
            />
          </div>
          <div className="truncate text-xs text-[var(--ema-text-tertiary)]" title={sessionTitle ?? undefined}>
            发往 {sessionTitle ?? '未打开会话'}
          </div>
          <Textarea
            aria-label="语音草稿"
            value={draftText}
            minRows={2}
            maxRows={5}
            disabled={sessionTitle === null}
            onChange={event => editDraft(event.target.value)}
          />
          <div className="flex items-center gap-2">
            <Tooltip content={microphoneLabel}>
              <IconButton
                label={microphoneLabel}
                size="sm"
                toggled={listeningStatus !== 'off'}
                iconNode={<VoiceIcon url={microphoneIcon} />}
                onClick={toggleListening}
              />
            </Tooltip>
            <div className="flex-1" />
            <Tooltip content="丢弃文字">
              <IconButton
                label="丢弃文字"
                size="sm"
                variant="ghost"
                iconNode={<VoiceIcon url={discardIcon} />}
                disabled={!draftText}
                onClick={clearDraft}
              />
            </Tooltip>
            <IconButton
              label="发送"
              size="md"
              variant="primary"
              className="rounded-[10px]"
              icon="i-lucide:arrow-up"
              loading={isSending}
              disabled={!canSend}
              onClick={sendDraft}
            />
          </div>
        </section>
      )}
      <div data-pet-interactive>
        <IconButton
          label={isExpanded ? '收起麦克风面板' : '展开麦克风面板'}
          aria-expanded={isExpanded}
          size="lg"
          toggled={listeningStatus !== 'off'}
          iconNode={<VoiceIcon url={microphoneIcon} />}
          onClick={() => setIsExpanded(expanded => !expanded)}
        />
      </div>
    </div>
  );
}
