// 展示当前 Session 的队首 Permission 或 AskUser, 后续交互继续留在服务端单队列中.
import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import { Button, Card, CardButton, Textarea } from '@ema-agent/ui';
import type { PermissionRequest, PermissionResponse } from '@ema-agent/permission';
import type { AskUserQuestionSpec, AskUserRequiredEvent } from '@ema-agent/tools';
import type { PendingInteraction } from '@ema-agent/turn';
import { AgentWebSocketCommandError } from '../../api/websocket.js';
import { useAgentStore } from '../../stores/agent.js';
import { useChatWorkspace } from '../state/chatWorkspace.js';

function useSubmission(): {
  submitting: boolean;
  error?: string;
  run(operation: () => Promise<unknown>): Promise<void>;
} {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const busy = useRef(false);
  return {
    submitting,
    error,
    async run(operation) {
      if (busy.current) return;
      busy.current = true;
      setSubmitting(true);
      setError(undefined);
      try {
        await operation();
      } catch (cause) {
        // 另一窗口可能已经处理了同一队首. 此时服务端恢复消息会移除卡片, 不把过期回答显示成失败.
        if (!(cause instanceof AgentWebSocketCommandError && cause.code === 'not_found_or_expired')) {
          setError(cause instanceof Error ? cause.message : '提交失败, 请重试');
        }
      } finally {
        busy.current = false;
        setSubmitting(false);
      }
    },
  };
}

function Feedback({
  submitting,
  error,
}: {
  submitting: boolean;
  error?: string;
}): JSX.Element | null {
  if (!submitting && !error) return null;

  return (
    <p
      role={error ? 'alert' : 'status'}
      className={`mt-2 text-xs ${
        error
          ? 'text-[var(--ema-danger-text)]'
          : 'text-[var(--ema-text-tertiary)]'
      }`}
    >
      {error ?? '正在提交…'}
    </p>
  );
}

function CollapsibleCard({
  title,
  collapsed,
  onToggle,
  headerRight,
  children,
}: {
  title: string;
  collapsed: boolean;
  onToggle(): void;
  headerRight?: JSX.Element;
  children: JSX.Element;
}): JSX.Element {
  return (
    <Card
      variant="elevated"
      padding="none"
      className="w-full overflow-hidden border border-[var(--ema-border)] shadow-[var(--ema-shadow-2)]"
    >
      <div className="flex min-h-10 items-center gap-3 px-4 py-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--ema-text-secondary)]">
          {title}
        </span>
        {headerRight}
        <button
          type="button"
          className={`i-lucide:chevron-down text-xs text-[var(--ema-text-tertiary)] transition-transform ${
            collapsed ? '-rotate-90' : ''
          }`}
          aria-label={collapsed ? '展开交互' : '折叠交互'}
          onClick={onToggle}
        />
      </div>
      <div
        className="ema-collapsible"
        style={{
          gridTemplateRows: collapsed ? '0fr' : '1fr',
          opacity: collapsed ? 0 : 1,
        }}
      >
        <div>
          <div className="border-t border-[var(--ema-border)] px-4 pb-4 pt-3">
            {children}
          </div>
        </div>
      </div>
    </Card>
  );
}

function PermissionView({
  sessionId,
  request,
}: {
  sessionId: string;
  request: PermissionRequest;
}): JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  const submission = useSubmission();
  const respond = (response: PermissionResponse): void => {
    void submission.run(() => (
      useAgentStore.getState().respondPermission(
        sessionId,
        request.turnId,
        request.toolCallId,
        response,
      )
    ));
  };
  const rawInput = typeof request.input === 'string' ? request.input : JSON.stringify(request.input, null, 2);
  return (
    <CollapsibleCard
      title={request.toolDescription ?? `即将运行 ${request.toolName}`}
      collapsed={collapsed}
      onToggle={() => setCollapsed((value) => !value)}
    >
      <>
        <div className="max-h-56 overflow-auto rounded-xl bg-[var(--ema-bg)] p-3 font-mono text-xs text-[var(--ema-text-secondary)]">
          <div className="mb-1 font-semibold text-[var(--ema-primary)]">{request.toolName}</div>
          <pre className="whitespace-pre-wrap">{rawInput}</pre>
        </div>
        <div className="mt-4 flex items-center justify-between gap-2">
          <Button
            variant="danger"
            size="sm"
            disabled={submission.submitting}
            onClick={() => respond({ action: 'deny' })}
          >
            拒绝
          </Button>
          <div className="flex gap-2">
            {request.ruleSuggestion && (
              <Button
                variant="secondary"
                size="sm"
                disabled={submission.submitting}
                onClick={() => respond({ action: 'allowSession' })}
              >
                本会话允许
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              disabled={submission.submitting}
              onClick={() => respond({ action: 'allow' })}
            >
              允许
            </Button>
          </div>
        </div>
        <Feedback submitting={submission.submitting} error={submission.error} />
      </>
    </CollapsibleCard>
  );
}

type SelectedAnswers = Record<string, string[]>;

function resolvedAnswer(
  question: AskUserQuestionSpec,
  selected: SelectedAnswers,
  custom: Record<string, string>,
): string {
  return [
    ...(selected[question.id] ?? []),
    custom[question.id]?.trim() ?? '',
  ].filter(Boolean).join(', ');
}

function AskUserView({
  sessionId,
  request,
}: {
  sessionId: string;
  request: AskUserRequiredEvent;
}): JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  const [step, setStep] = useState(0);
  const [selected, setSelected] = useState<SelectedAnswers>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [customActive, setCustomActive] = useState<Record<string, boolean>>({});
  const submission = useSubmission();
  const questionAtStep = request.questions[step];

  useEffect(() => {
    setStep((current) => Math.min(
      current,
      Math.max(0, request.questions.length - 1),
    ));
  }, [request.questions.length]);

  if (!questionAtStep) return <></>;
  const question = questionAtStep;

  const answer = resolvedAnswer(question, selected, custom);
  const answers = Object.fromEntries(request.questions.map((item) => [
    item.id,
    resolvedAnswer(item, selected, custom),
  ]));
  const allAnswered = request.questions.every((item) => (
    Boolean(answers[item.id]?.trim())
  ));

  function toggleOption(label: string): void {
    setSelected((current) => {
      const values = current[question.id] ?? [];
      const next = question.multiSelect
        ? values.includes(label)
          ? values.filter((value) => value !== label)
          : [...values, label]
        : [label];
      return { ...current, [question.id]: next };
    });
    if (!question.multiSelect) {
      setCustomActive((current) => ({ ...current, [question.id]: false }));
    }
  }

  function toggleCustom(): void {
    setCustomActive((current) => ({
      ...current,
      [question.id]: !current[question.id],
    }));
    if (!question.multiSelect) {
      setSelected((current) => ({ ...current, [question.id]: [] }));
    }
  }

  const marks = (
    <div
      className="flex items-center gap-2"
      aria-label={`${step + 1}/${request.questions.length} 个问题`}
    >
      {request.questions.map((item, index) => (
        <button
          key={item.id}
          type="button"
          className={`h-0.5 w-4 rounded-full transition-colors ${
            index === step
              ? 'bg-[var(--ema-text-primary)]'
              : resolvedAnswer(item, selected, custom)
                ? 'bg-[var(--ema-primary)]'
                : 'bg-[var(--ema-text-tertiary)]/60'
          }`}
          aria-label={`跳转到第 ${index + 1} 个问题`}
          onClick={() => setStep(index)}
        />
      ))}
    </div>
  );

  return (
    <CollapsibleCard
      title={`${step + 1}/${request.questions.length} 个问题`}
      collapsed={collapsed}
      onToggle={() => setCollapsed((value) => !value)}
      headerRight={marks}
    >
      <>
        {request.humanDescription && (
          <p className="mb-3 text-sm text-[var(--ema-text-secondary)]">
            {request.humanDescription}
          </p>
        )}
        <p className="text-xs text-[var(--ema-text-tertiary)]">{question.header}</p>
        <p className="mb-3 mt-1 text-sm font-medium text-[var(--ema-text-primary)]">{question.question}</p>
        <div className="flex flex-col gap-2">
          {(question.options ?? []).map((option, index) => {
            const active = selected[question.id]?.includes(option.label) ?? false;
            return (
              <CardButton
                key={option.label}
                selected={active}
                padding="sm"
                className="ema-stagger-in"
                style={{ '--stagger-i': index } as CSSProperties}
                onClick={() => toggleOption(option.label)}
              >
                <div className="flex items-start gap-2">
                  <span
                    className={`${question.multiSelect
                      ? active ? 'i-lucide:square-check-big' : 'i-lucide:square'
                      : active ? 'i-lucide:circle-dot' : 'i-lucide:circle'} mt-0.5 shrink-0`}
                    aria-hidden
                  />
                  <span>
                    <span className="block text-sm font-medium">{option.label}</span>
                    {option.description && (
                      <span className="mt-0.5 block text-xs text-[var(--ema-text-tertiary)]">
                        {option.description}
                      </span>
                    )}
                  </span>
                </div>
              </CardButton>
            );
          })}
          <CardButton
            selected={customActive[question.id] === true}
            padding="sm"
            onClick={toggleCustom}
          >
            <div className="flex items-start gap-2">
              <span
                className={`${question.multiSelect
                  ? customActive[question.id] ? 'i-lucide:square-check-big' : 'i-lucide:square'
                  : customActive[question.id] ? 'i-lucide:circle-dot' : 'i-lucide:circle'} mt-0.5 shrink-0`}
                aria-hidden
              />
              <span className="text-sm font-medium">输入自己的答案</span>
            </div>
            {customActive[question.id] && (
              <Textarea
                className="mt-2"
                minRows={2}
                maxRows={5}
                autoFocus
                placeholder="输入你的答案…"
                value={custom[question.id] ?? ''}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => setCustom((current) => ({
                  ...current,
                  [question.id]: event.target.value,
                }))}
              />
            )}
          </CardButton>
        </div>
        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            className="mr-auto px-2 py-1 text-xs font-medium text-[var(--ema-text-primary)] hover:text-[var(--ema-danger)]"
            disabled={submission.submitting}
            onClick={() => void submission.run(() => (
              useAgentStore.getState().cancelAskUser(
                sessionId,
                request.turnId,
                request.toolCallId,
              )
            ))}
          >
            忽略
          </button>
          {step > 0 && (
            <Button
              variant="secondary"
              size="sm"
              disabled={submission.submitting}
              onClick={() => setStep((value) => value - 1)}
            >
              返回
            </Button>
          )}
          {step < request.questions.length - 1
            ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={!answer || submission.submitting}
                onClick={() => setStep((value) => value + 1)}
              >
                下一步
              </Button>
            )
            : (
              <Button
                variant="primary"
                size="sm"
                disabled={!allAnswered || submission.submitting}
                onClick={() => void submission.run(() => (
                  useAgentStore.getState().respondAskUser(
                    sessionId,
                    request.turnId,
                    request.toolCallId,
                    answers,
                  )
                ))}
              >
                提交
              </Button>
            )}
        </div>
        <Feedback submitting={submission.submitting} error={submission.error} />
      </>
    </CollapsibleCard>
  );
}

function Interaction({
  entry,
  sessionId,
}: {
  entry: PendingInteraction;
  sessionId: string;
}): JSX.Element {
  return entry.kind === 'permission'
    ? <PermissionView sessionId={sessionId} request={entry.request} />
    : <AskUserView sessionId={sessionId} request={entry.request} />;
}

export function PendingInteractionView(): JSX.Element | null {
  const sessionId = useChatWorkspace((state) => state.viewedSessionId);
  const current = useAgentStore((state) => (
    sessionId
      ? state.sessions.get(sessionId)?.pendingInteractions[0]
      : undefined
  ));

  if (!sessionId || !current) return null;

  return (
    <div className="mb-2 w-full ema-slide-up">
      <Interaction
        key={current.request.toolCallId}
        entry={current}
        sessionId={sessionId}
      />
    </div>
  );
}
