import { useCallback, useEffect, useRef, useState } from 'react';
import type { MicVAD } from '@ricky0123/vad-web';
import { providersApi } from '../../api/providers.js';
import { showToast } from '../../lib/notifications/toast.js';
import { tauriBridge } from '../../lib/tauri/tauriBridge.js';
import type { StageVoiceContextChange, StageVoiceSendRequest, StageVoiceSendResult, StageVoiceSession } from '../../lib/tauri/types.js';

interface StageVoiceInputOptions {
  /** Stage 隐藏时释放麦克风, 收起输入面板时仍可监听. */
  readonly suspended: boolean;
}

interface RecordingTarget {
  readonly sessionId: string;
  // 录音开始时保存. 取消归档后同一个 ID 的新录音会取得另一个 signal.
  readonly signal: AbortSignal;
}

interface MicrophoneListening {
  stream?: MediaStream;
  audioContext?: AudioContext;
  detector?: MicVAD;
}

type ListeningStatus = 'off' | 'starting' | 'listening';

function appendDraftText(current: string, added: string): string {
  return current ? `${current} ${added}` : added;
}

function releaseMicrophone(listening: MicrophoneListening): void {
  listening.stream?.getTracks().forEach(track => track.stop());
  if (!listening.detector) return;
  void listening.detector.destroy()
    .catch(error => console.warn('[stage-voice] 停止检测失败', error))
    .finally(() => listening.audioContext?.close())
    .catch(error => console.warn('[stage-voice] 关闭音频上下文失败', error));
}

export function useStageVoiceInput({ suspended }: StageVoiceInputOptions) {
  const [listeningStatus, setListeningStatus] = useState<ListeningStatus>('off');
  const [viewedSessionId, setViewedSessionId] = useState<string | null>(null);
  const [sessionsById, setSessionsById] = useState<ReadonlyMap<string, StageVoiceSession>>(() => new Map());
  const [draftsBySessionId, setDraftsBySessionId] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [isSending, setIsSending] = useState(false);
  const viewedSession = viewedSessionId ? sessionsById.get(viewedSessionId) : undefined;
  const draftText = viewedSession ? draftsBySessionId.get(viewedSession.sessionId) ?? '' : '';

  // 录音回调长期存活, 事件到达时更新这些值, 避免回调读到开启监听时的会话.
  const latestViewedSessionId = useRef<string | null>(null);
  const sessionsByIdRef = useRef(sessionsById);
  // 角色播放期间进行录音可能导致麦克风把两句都收进去, 因此需要字段记录
  // 但不代表角色播放音频期间不能进行录音, 若开启回声消除, 回声消除会尽量压低麦克风里从扬声器传来的角色声音
  const isEmaPlaying = useRef(false);
  const microphone = useRef<MicrophoneListening | null>(null);
  const currentRecording = useRef<RecordingTarget | null>(null);
  // 每个会话的录音和 STT 共用取消信号, X 清空文字时保留这个信号.
  const abortControllersBySessionId = useRef(new Map<string, AbortController>());
  const transcriptionQueue = useRef(Promise.resolve());
  // 点发送时保存这次提交的文字. 回执只处理这次提交, 之后新增的草稿仍可编辑.
  const pendingSend = useRef<StageVoiceSendRequest | null>(null);

  const stopListening = useCallback((): void => {
    const listening = microphone.current;
    microphone.current = null;
    // 点停时, 正说到一半或者还没交给 STT 的那段会被丢掉, 麦克风也会释放. 
    // 已经收完并排队的语音段, 以及已经发出的 STT 请求, 都会继续处理, 返回后照常补到各自的草稿.
    // 所以这里没有进行abort
    currentRecording.current = null;
    if (listening) releaseMicrophone(listening);
    setListeningStatus('off');
  }, []);

  useEffect(() => {
    if (suspended) stopListening();
  }, [suspended, stopListening]);

  useEffect(() => {
    if (!tauriBridge.isTauri()) return;
    let disposed = false;

    function receiveContext(change: StageVoiceContextChange): void {
      if (disposed) return;
      if (change.type === 'viewed-session') {
        latestViewedSessionId.current = change.sessionId;
        setViewedSessionId(change.sessionId);
      } else if (change.type === 'playback') {
        isEmaPlaying.current = change.isPlaying;
      } else if (change.type === 'sessions') {
        const nextSessionsById = new Map(change.sessions.map(session => [session.sessionId, session]));
        // 转写回调可以在界面重新渲染前读取新表, 两处共用同一个 Map.
        sessionsByIdRef.current = nextSessionsById;
        setSessionsById(nextSessionsById);
        // 在事件里立刻取消, 即使归档和取消归档的通知一起进入 React 渲染, 旧录音也会作废.
        for (const [sessionId, controller] of abortControllersBySessionId.current) {
          if (nextSessionsById.has(sessionId)) continue;
          abortControllersBySessionId.current.delete(sessionId);
          controller.abort();
        }
        if (pendingSend.current && !nextSessionsById.has(pendingSend.current.sessionId)) {
          pendingSend.current = null;
          setIsSending(false);
        }
        setDraftsBySessionId(previous => {
          const removedDraftIds = [...previous.keys()].filter(sessionId => !nextSessionsById.has(sessionId));
          if (removedDraftIds.length === 0) return previous;
          const drafts = new Map(previous);
          for (const sessionId of removedDraftIds) drafts.delete(sessionId);
          return drafts;
        });
      }
    }

    function receiveSendResult(result: StageVoiceSendResult): void {
      const request = pendingSend.current;
      if (disposed || !request || request.requestId !== result.requestId) return;
      pendingSend.current = null;
      setIsSending(false);
      if (result.status === 'accepted' || !sessionsByIdRef.current.has(request.sessionId)) return;
      if (result.status === 'rejected') {
        setDraftsBySessionId(previous => {
          const drafts = new Map(previous);
          drafts.set(request.sessionId, appendDraftText(request.text, drafts.get(request.sessionId) ?? ''));
          return drafts;
        });
      }
      const message = result.status === 'unknown' ? `发送结果未确认: ${result.message}` : result.message;
      showToast(message, { variant: 'danger' });
    }

    const subscriptions = [
      tauriBridge.listenStageVoiceContext(receiveContext),
      tauriBridge.listenStageVoiceSendResult(receiveSendResult),
    ];
    // Stage 先准备好接收回执和会话状态, 再请求 main 发当前值.
    void Promise.all(subscriptions).then(async () => {
      if (!disposed) await tauriBridge.requestStageVoiceContext();
    }).catch(error => console.warn('[stage-voice] 读取会话状态失败', error));

    return () => {
      disposed = true;
      for (const subscription of subscriptions) {
        void subscription.then(unlisten => unlisten()).catch(() => {});
      }
      const listening = microphone.current;
      microphone.current = null;
      if (listening) releaseMicrophone(listening);
      currentRecording.current = null;
      pendingSend.current = null;
      for (const controller of abortControllersBySessionId.current.values()) controller.abort();
      abortControllersBySessionId.current.clear();
    };
  }, []);

  function onRecordingStarted(): void {
    currentRecording.current = null;
    const sessionId = latestViewedSessionId.current;
    if (!sessionId || !sessionsByIdRef.current.has(sessionId)) return;
    if (isEmaPlaying.current) {
      // 只有音轨实际启用了回声消除, 才在角色播放期间接收新录音.
      const track = microphone.current?.stream?.getAudioTracks()[0];
      if (track?.getSettings().echoCancellation !== true) return;
    }

    const controllers = abortControllersBySessionId.current;
    let controller = controllers.get(sessionId);
    if (!controller) {
      controller = new AbortController();
      controllers.set(sessionId, controller);
    }
    currentRecording.current = { sessionId, signal: controller.signal };
  }

  function queueTranscription(recording: RecordingTarget, encodeRecordingWAV: () => ArrayBuffer): void {
    // 按检测到的顺序上传, 避免后说的那段先回到编辑框.
    transcriptionQueue.current = transcriptionQueue.current.then(async () => {
      const { sessionId, signal } = recording;
      if (signal.aborted || !sessionsByIdRef.current.has(sessionId)) return;
      const audio = new Blob([encodeRecordingWAV()], { type: 'audio/wav' });
      const { text } = await providersApi.transcribe({ audio, mime: audio.type }, signal);
      if (signal.aborted || !sessionsByIdRef.current.has(sessionId)) return;
      const transcript = text.trim();
      if (!transcript) return;
      setDraftsBySessionId(previous => {
        // React 可能延后处理这次更新, 期间归档也不能让旧结果补回草稿.
        if (signal.aborted) return previous;
        const drafts = new Map(previous);
        drafts.set(sessionId, appendDraftText(drafts.get(sessionId) ?? '', transcript));
        return drafts;
      });
    }).catch(error => {
      if (!recording.signal.aborted) {
        showToast(error instanceof Error ? error.message : '语音转写失败', { variant: 'danger' });
      }
    });
  }

  async function startListening(): Promise<void> {
    if (suspended || microphone.current) return;
    const listening: MicrophoneListening = {};
    microphone.current = listening;
    setListeningStatus('starting');
    try {
      // 开启回声消除, 回声消除会尽量压低麦克风里从扬声器传来的角色声音
      // 避免出现麦克风录音时, 角色播放的声音也被收进去了, 导致转写结果里出现了角色的台词
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      listening.stream = stream;
      // 等待麦克风返回期间, 用户可能已停止或重新开启监听.
      // 如果这次开启已失效, 就关闭它刚拿到的音轨.
      if (microphone.current !== listening) {
        releaseMicrophone(listening);
        return;
      }
      // 只在用户启用监听时加载模型和 ONNX 运行库.
      const { MicVAD, utils } = await import('@ricky0123/vad-web');
      // 停止监听期间 stream 已由 stopListening 释放, 此时还没有 detector 和需要单独关闭的资源.
      // 不需要再加一行 releaseMicrophone(listening) 了, 不过加了也没啥影响
      if (microphone.current !== listening) return;
      const assetPath = new URL('voice-input-assets/', document.baseURI).href;
      const audioContext = new AudioContext();
      listening.audioContext = audioContext;
      listening.detector = await MicVAD.new({
        model: 'v5',
        baseAssetPath: assetPath,
        onnxWASMBasePath: assetPath,
        audioContext,
        getStream: async () => stream,
        ortConfig(ort) {
          ort.env.wasm.numThreads = 1;
          ort.env.wasm.proxy = false;
        },
        onSpeechStart() {
          if (microphone.current === listening) onRecordingStarted();
        },
        onVADMisfire() {
          if (microphone.current === listening) currentRecording.current = null;
        },
        onSpeechEnd(samples) {
          if (microphone.current !== listening) return;
          const recording = currentRecording.current;
          currentRecording.current = null;
          if (!recording) return;
          // MicVAD 给的是 16 kHz 浮点采样. 这里包装成 STT 可读的单声道 16 bit PCM WAV.
          queueTranscription(recording, () => utils.encodeWAV(samples, 1, 16_000, 1, 16));
        },
      });
      if (microphone.current !== listening) {
        releaseMicrophone(listening);
        return;
      }
      setListeningStatus('listening');
    } catch (error) {
      releaseMicrophone(listening);
      // 初始化失败可能还没有可销毁的 MicVAD, AudioContext 由本窗口创建并关闭.
      if (!listening.detector && listening.audioContext) {
        void listening.audioContext.close().catch(() => {});
      }
      if (microphone.current !== listening) return;
      microphone.current = null;
      currentRecording.current = null;
      setListeningStatus('off');
      showToast(error instanceof Error ? error.message : '开启麦克风失败', { variant: 'danger' });
    }
  }

  function setSessionDraftText(sessionId: string, text: string): void {
    setDraftsBySessionId(previous => {
      const drafts = new Map(previous);
      if (text) drafts.set(sessionId, text);
      else drafts.delete(sessionId);
      return drafts;
    });
  }

  function sendDraft(): void {
    const text = draftText.trim();
    if (!viewedSession || !text || pendingSend.current) return;
    const { sessionId } = viewedSession;
    if (!sessionsByIdRef.current.has(sessionId)) return;

    const request = { requestId: crypto.randomUUID(), sessionId, text };
    pendingSend.current = request;
    setIsSending(true);
    setSessionDraftText(sessionId, '');
    void tauriBridge.sendStageVoiceDraft(request).catch(error => {
      if (pendingSend.current !== request) return;
      pendingSend.current = null;
      setIsSending(false);
      if (!sessionsByIdRef.current.has(sessionId)) return;
      setDraftsBySessionId(previous => {
        const drafts = new Map(previous);
        drafts.set(sessionId, appendDraftText(text, drafts.get(sessionId) ?? ''));
        return drafts;
      });
      showToast(error instanceof Error ? error.message : '无法将语音草稿交给主窗口', { variant: 'danger' });
    });
  }

  function toggleListening(): void {
    if (microphone.current) stopListening();
    else void startListening();
  }

  function editDraft(text: string): void {
    if (viewedSession) setSessionDraftText(viewedSession.sessionId, text);
  }

  function clearDraft(): void {
    editDraft('');
  }

  return {
    listeningStatus,
    sessionTitle: viewedSession?.title ?? null,
    draftText,
    isSending,
    canSend: Boolean(viewedSession && draftText.trim() && !isSending),
    toggleListening,
    editDraft,
    clearDraft,
    sendDraft,
  };
}
