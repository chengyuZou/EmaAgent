import { memo, useEffect, useRef, type JSX } from 'react';
import { IconButton, Tooltip } from '@ema-agent/ui';

export type VoiceInputState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'starting' }
  | { readonly kind: 'recording'; readonly stream: MediaStream }
  | { readonly kind: 'transcribing' };

const VOLUME_SAMPLE_INTERVAL_MS = 40;

function RecordingWaveform({ stream }: { readonly stream: MediaStream | null }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const element = canvasRef.current;
    if (!element || !stream) return;
    const canvas = element;
    const context = canvas.getContext('2d');
    if (!context) return;
    const drawing = context;

    const audio = new AudioContext();
    const source = audio.createMediaStreamSource(stream);
    const analyser = audio.createAnalyser();
    analyser.fftSize = 1024;
    // 这里只看麦克风音量, 不接 destination, 避免从扬声器回放自己的录音.
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let levels = new Float32Array(0);
    let nextWrite = 0;
    let width = 0;
    let height = 0;
    let pixelRatio = 1;
    let barWidth = 2;
    let barStep = 6;
    let color = '';
    let peakVolume = 0;
    let lastSampleAt = performance.now();
    let frameId = 0;
    let disposed = false;

    function readAppearance(): void {
      const style = getComputedStyle(canvas);
      color = style.color;
      barWidth = parseFloat(style.getPropertyValue('--ema-voice-bar-width'));
      barStep = barWidth + parseFloat(style.getPropertyValue('--ema-voice-bar-gap'));
    }

    function resize(): void {
      const bounds = canvas.getBoundingClientRect();
      width = bounds.width;
      height = bounds.height;
      pixelRatio = window.devicePixelRatio;
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);

      // 只保留这一行能画出的音量. 环形数组重复使用位置, 不累计整段录音的显示历史.
      const resized = new Float32Array(Math.ceil(width / barStep) + 2);
      const retained = Math.min(levels.length, resized.length);
      for (let offset = 1; offset <= retained; offset += 1) {
        resized[resized.length - offset] = levels[(nextWrite + levels.length - offset) % levels.length]!;
      }
      levels = resized;
      nextWrite = 0;
    }

    function draw(now: number): void {
      analyser.getFloatTimeDomainData(samples);
      let squares = 0;
      for (const sample of samples) squares += sample * sample;
      peakVolume = Math.max(peakVolume, Math.sqrt(squares / samples.length));

      if (now - lastSampleAt >= VOLUME_SAMPLE_INTERVAL_MS) {
        // 放大的是显示高度, 不改变 MediaRecorder 保存的音量.
        levels[nextWrite] = Math.min(1, peakVolume * 10);
        nextWrite = (nextWrite + 1) % levels.length;
        peakVolume = 0;
        lastSampleAt = now;
      }
      if (window.devicePixelRatio !== pixelRatio) resize();
      drawing.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      drawing.clearRect(0, 0, width, height);
      drawing.strokeStyle = color;
      drawing.lineWidth = barWidth;
      drawing.lineCap = 'round';

      // 两次取音量之间平滑移动, 不靠复制上一帧的像素造成模糊或拖影.
      const shift = reducedMotion.matches
        ? 0
        : (now - lastSampleAt) / VOLUME_SAMPLE_INTERVAL_MS * barStep;
      for (let age = 0; age < levels.length; age += 1) {
        const x = width - barWidth / 2 - age * barStep - shift;
        const volume = levels[(nextWrite + levels.length - 1 - age) % levels.length]!;
        const halfHeight = Math.max(0.1, volume * (height / 2 - barWidth * 2));
        drawing.globalAlpha = 0.35 + 0.65 * Math.max(0, x / width);
        drawing.beginPath();
        drawing.moveTo(x, height / 2 - halfHeight);
        drawing.lineTo(x, height / 2 + halfHeight);
        drawing.stroke();
      }
      frameId = requestAnimationFrame(draw);
    }

    readAppearance();
    resize();
    const sizeObserver = new ResizeObserver(resize);
    sizeObserver.observe(canvas);
    const themeObserver = new MutationObserver(readAppearance);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class', 'style'],
    });
    void audio.resume().catch(error => {
      if (!disposed) console.warn('[voice-input] 无法开始音量分析', error);
    });
    frameId = requestAnimationFrame(draw);

    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      sizeObserver.disconnect();
      themeObserver.disconnect();
      source.disconnect();
      analyser.disconnect();
      // 麦克风流由 ChatInput 的录音流程关闭, 绘图组件只释放自己的分析资源.
      void audio.close().catch(error => console.warn('[voice-input] 释放音量分析失败', error));
    };
  }, [stream]);

  return <canvas ref={canvasRef} className="ema-voice-waveform" aria-hidden />;
}

export const VoiceInputBar = memo(function VoiceInputBar({
  state,
  onCancel,
  onStop,
}: {
  readonly state: VoiceInputState;
  readonly onCancel: () => void;
  readonly onStop: () => void;
}): JSX.Element {
  const active = state.kind !== 'idle';
  const recording = state.kind === 'recording';
  let cancelLabel = '取消录音';
  let statusText = '';
  if (state.kind === 'starting') {
    cancelLabel = '取消语音输入';
    statusText = '正在开启麦克风...';
  } else if (state.kind === 'transcribing') {
    cancelLabel = '取消转写';
    statusText = '正在转写...';
  }

  return (
    <div
      className="ema-voice-input-bar"
      data-active={active}
      data-recording={recording}
      ref={element => {
        if (element) element.inert = !active;
      }}
    >
      <Tooltip content={cancelLabel} side="top">
        <IconButton
          size="sm"
          variant="ghost"
          icon="i-lucide:x"
          label={cancelLabel}
          className="ema-voice-action"
          onClick={onCancel}
        />
      </Tooltip>
      <div className="ema-voice-display">
        <RecordingWaveform stream={recording ? state.stream : null} />
        <div className="ema-voice-status" role="status" aria-live="polite">
          {recording ? (
            <span className="sr-only">正在录音</span>
          ) : (
            <>
              <span className="ema-voice-spinner i-lucide:loader-circle" aria-hidden />
              <span>{statusText}</span>
            </>
          )}
        </div>
      </div>
      <Tooltip content="停止录音并转写" side="top">
        <IconButton
          size="sm"
          variant="ghost"
          iconNode={<span className="ema-voice-stop-symbol" />}
          label="停止录音并转写"
          className="ema-voice-action ema-voice-stop"
          disabled={!recording}
          aria-hidden={!recording}
          onClick={onStop}
        />
      </Tooltip>
    </div>
  );
});
