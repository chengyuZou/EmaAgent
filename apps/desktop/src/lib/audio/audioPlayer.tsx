import { useEffect, useRef, useState, type JSX } from 'react';
import H5AudioPlayer, { RHAP_UI } from 'react-h5-audio-player';
import { IconButton, Tooltip } from '@ema-agent/ui';
import { filesApi } from '../../api/workspaces.js';

type AudioSource = {
  readonly src: string;
  readonly filePath?: never;
} | {
  readonly filePath: string;
  readonly src?: never;
};

export type AudioPlayerProps = AudioSource & {
  readonly title: string;
  readonly className?: string;
  /** 页面或文件标签隐藏时暂停, 再次显示时不自动播放. */
  readonly active?: boolean;
};

/** 只判断地址中的文件后缀, 不根据说明文字猜测资源类型. */
export function isAudioSource(src: string): boolean {
  let path = src;
  if (/^(?:https?:|file:)/i.test(src)) {
    try {
      path = new URL(src).pathname;
    } catch {
      return false;
    }
  } else if (!/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(src)) {
    path = src.split(/[?#]/, 1)[0] ?? '';
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    // 非法百分号编码保留原文, 仍只判断文件后缀.
  }
  return /\.(?:mp3|wav|m4a|aac|ogg|oga|flac|opus|webm)$/i.test(path);
}

// 普通音频卡片之间只暂停上一张, 不重置其进度, 也不取消 Turn 的语音生成.
let playingAudio: HTMLAudioElement | undefined;

export function AudioPlayer(props: AudioPlayerProps): JSX.Element {
  const key = props.filePath ?? props.src;
  if (props.filePath !== undefined) {
    return <FileAudio key={key} {...props} filePath={props.filePath} />;
  }
  return <PlayableAudio key={key} {...props} src={props.src} />;
}

function FileAudio({ filePath, ...props }: Omit<AudioPlayerProps, 'src' | 'filePath'> & {
  readonly filePath: string;
}): JSX.Element {
  const [src, setSrc] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    // 这里只取得带口令的播放地址. 文件请求和缓冲由浏览器的 audio 处理, 应用不下载整段 Blob.
    void filesApi.audioUrl(filePath).then(url => {
      if (!cancelled) {
        setSrc(url);
      }
    }).catch(error => {
      if (!cancelled) {
        setError(error instanceof Error ? error.message : '无法取得音频地址');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  if (src) {
    return <PlayableAudio {...props} src={src} />;
  }
  return (
    <div className={`ema-audio-player${props.className ? ` ${props.className}` : ''}`} role="status">
      <div className="ema-audio-title">{props.title}</div>
      <div className="ema-audio-status">{error ?? '准备音频中…'}</div>
    </div>
  );
}

function PlayableAudio({ src, title, className, active = true }: {
  readonly src: string;
  readonly title: string;
  readonly className?: string;
  readonly active?: boolean;
}): JSX.Element {
  const player = useRef<H5AudioPlayer>(null);
  const enabled = useRef(active);
  const mounted = useRef(true);
  const [error, setError] = useState<string>();
  enabled.current = active;

  useEffect(() => {
    mounted.current = true;
    const audio = player.current?.audio.current;
    // StrictMode 会先清理再重新运行 effect, 此时仍是同一个 audio 节点, 需要恢复被清理的地址.
    if (audio && audio.getAttribute('src') !== src) {
      audio.setAttribute('src', src);
    }
    return () => {
      mounted.current = false;
      if (!audio) {
        return;
      }
      if (playingAudio === audio) {
        playingAudio = undefined;
      }
      audio.pause();
      // 暂停本身不会终止文件读取. 移除地址后 load, 才会停止请求并释放已缓冲的音频.
      audio.removeAttribute('src');
      audio.load();
    };
  }, [src]);

  useEffect(() => {
    if (!active) {
      player.current?.audio.current?.pause();
    }
  }, [active]);

  function onPlay(): void {
    const audio = player.current?.audio.current;
    if (!audio) {
      return;
    }
    // play 请求可能在切走页面后才完成. 不允许隐藏的卡片继续发声.
    if (!enabled.current || !mounted.current) {
      audio.pause();
      return;
    }
    if (playingAudio && playingAudio !== audio) {
      playingAudio.pause();
    }
    playingAudio = audio;
    setError(undefined);
  }

  function releasePlayingAudio(): void {
    if (playingAudio === player.current?.audio.current) {
      playingAudio = undefined;
    }
  }

  function stop(): void {
    const audio = player.current?.audio.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
  }

  return (
    <div
      className={`ema-audio-player${className ? ` ${className}` : ''}`}
      data-active={active}
      ref={element => {
        if (element) {
          element.inert = !active;
        }
      }}
    >
      <H5AudioPlayer
        ref={player}
        src={src}
        preload="none"
        autoPlay={false}
        autoPlayAfterSrcChange={false}
        layout="stacked-reverse"
        showJumpControls={false}
        showDownloadProgress={false}
        header={(
          <div className="ema-audio-heading">
            <span className="i-lucide:audio-lines" aria-hidden />
            <span className="ema-audio-title" title={title}>{title}</span>
          </div>
        )}
        customIcons={{
          play: <span className="i-lucide:play" aria-hidden />,
          pause: <span className="i-lucide:pause" aria-hidden />,
          volume: <span className="i-lucide:volume-2" aria-hidden />,
          volumeMute: <span className="i-lucide:volume-x" aria-hidden />,
        }}
        customControlsSection={[
          RHAP_UI.MAIN_CONTROLS,
          <Tooltip key="stop" content="停止并回到开头">
            <IconButton
              label="停止音频"
              icon="i-lucide:square"
              variant="ghost"
              size="sm"
              onClick={stop}
              // 让按钮自己的空格/回车点击生效, 不触发播放器外层的空格播放快捷键.
              onKeyDown={event => event.stopPropagation()}
            />
          </Tooltip>,
          RHAP_UI.VOLUME_CONTROLS,
        ]}
        customProgressBarSection={[RHAP_UI.CURRENT_TIME, RHAP_UI.PROGRESS_BAR, RHAP_UI.DURATION]}
        i18nAriaLabels={{
          player: `音频播放器：${title}`,
          progressControl: '音频进度',
          volumeControl: '音量',
          play: '播放音频',
          pause: '暂停音频',
          volume: '静音',
          volumeMute: '取消静音',
        }}
        onPlay={onPlay}
        onPlaying={onPlay}
        onPause={releasePlayingAudio}
        onEnded={releasePlayingAudio}
        onError={() => {
          releasePlayingAudio();
          if (mounted.current) {
            setError('音频无法加载，请检查文件是否存在或格式是否受支持。');
          }
        }}
        onPlayError={() => {
          if (mounted.current && enabled.current) {
            setError('音频未能播放，请重试。');
          }
        }}
      />
      {error && <div className="ema-audio-status" role="status">{error}</div>}
    </div>
  );
}
