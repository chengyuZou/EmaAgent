// 把 Character 的单一舞台呈现加载为 Live2D、立绘或空白占位。

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type JSX,
  type SetStateAction,
} from 'react';
import type {
  CharacterIllustrationStageEntry,
  CharacterLive2dStageEntry,
  CharacterStagePresentation,
} from '@ema-agent/characters';
import type {
  Live2DStageHandle,
  Live2DStageReadyInfo,
} from '@ema-agent/live2d-react';
import { charactersApi } from '../api/characters.js';
import { fetchServerObjectUrl } from '../lib/serverFileUrl.js';
import { tauriBridge } from '../lib/tauri-bridge.js';
import { EmaStageView } from './EmaStageView.js';

export interface CharacterStageProps {
  targetCharacterName: string | null;
  presentation: CharacterStagePresentation | null;
  suspended: boolean;
  onStageChanged?: (stage: ActiveLive2DStage | null) => void;
}

export interface ActiveLive2DStage {
  handle: Live2DStageHandle;
  hasExpressions: boolean;
}

interface LoadedLive2d {
  readonly characterName: string;
  readonly resource: CharacterLive2dStageEntry;
  readonly archive: Blob;
}

export function CharacterStage({
  targetCharacterName,
  presentation,
  suspended,
  onStageChanged,
}: CharacterStageProps): JSX.Element {
  const [loadedLive2d, setLoadedLive2d] = useState<LoadedLive2d | null>(null);
  const showsLive2d = presentation?.status === 'live2d'
    && presentation.characterName === targetCharacterName;

  useEffect(() => {
    if (!showsLive2d) {
      setLoadedLive2d(null);
      onStageChanged?.(null);
      return;
    }

    let cancelled = false;
    const { characterName, resource } = presentation;
    setLoadedLive2d(current => (
      current?.characterName === characterName ? current : null
    ));
    void charactersApi.live2dArchive(characterName, resource.name)
      .then((archive) => {
        if (!cancelled) {
          setLoadedLive2d({ characterName, resource, archive });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          console.error('[stage] Live2D 模型包读取失败', characterName, resource.name, error);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [onStageChanged, presentation, showsLive2d]);

  const ready = useCallback((
    handle: Live2DStageHandle,
    info: Live2DStageReadyInfo,
  ): void => {
    onStageChanged?.({
      handle,
      hasExpressions: info.hasExpressions,
    });
  }, [onStageChanged]);

  const live2dMatchesTarget = loadedLive2d?.characterName === targetCharacterName;
  const illustration = presentation?.status === 'illustration'
    && presentation.characterName === targetCharacterName
    ? presentation
    : null;

  return (
    <div className="ema-character-stage" data-tauri-drag-region={false}>
      {!live2dMatchesTarget && !illustration && (
        <div className="ema-character-stage-placeholder" aria-label="角色舞台占位">
          <span className="ema-character-stage-placeholder-ring" />
        </div>
      )}

      {live2dMatchesTarget && loadedLive2d && (
        <Live2dResource
          loaded={loadedLive2d}
          suspended={suspended}
          onReady={ready}
          onError={(error) => {
            console.error('[stage] Live2D 模型加载失败', loadedLive2d.resource.name, error);
            onStageChanged?.(null);
          }}
        />
      )}

      {illustration && (
        <IllustrationResource
          key={illustration.characterName}
          presentation={illustration}
        />
      )}
    </div>
  );
}

function Live2dResource({
  loaded,
  suspended,
  onReady,
  onError,
}: {
  loaded: LoadedLive2d;
  suspended: boolean;
  onReady(handle: Live2DStageHandle, info: Live2DStageReadyInfo): void;
  onError(error: Error): void;
}): JSX.Element {
  const handleRef = useRef<Live2DStageHandle | null>(null);
  const resource = loaded.resource;

  return (
    <div className="ema-character-stage-resource" data-state="active">
      <div
        className="ema-character-stage-resource-content"
        style={resourceTransform(resource)}
      >
        <EmaStageView
          modelArchive={loaded.archive}
          runtimeConfig={resource.runtimeConfig ?? undefined}
          suspended={suspended}
          onHandleChanged={(handle) => {
            handleRef.current = handle;
          }}
          onReady={(info) => {
            if (handleRef.current) onReady(handleRef.current, info);
          }}
          onError={onError}
        />
      </div>
    </div>
  );
}

function IllustrationResource({
  presentation,
}: {
  presentation: Extract<CharacterStagePresentation, { status: 'illustration' }>;
}): JSX.Element {
  const [desired, setDesired] = useState(presentation.resource);
  const [displayed, setDisplayed] = useState<LoadedIllustration | null>(null);
  const [outgoing, setOutgoing] = useState<LoadedIllustration | null>(null);
  const displayedRef = useRef<LoadedIllustration | null>(null);
  const outgoingRef = useRef<LoadedIllustration | null>(null);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setDesired(presentation.resource);
  }, [presentation]);

  // 相同情绪也重新抽取,让一组同语义立绘产生 Galgame 式变化.
  useEffect(() => {
    return listenForIllustrationEmotion(presentation, setDesired);
  }, [presentation]);

  // 新图完成浏览器解码后再替换旧图,避免认证读取和图片解码期间舞台闪空.
  useEffect(() => {
    let cancelled = false;
    void fetchServerObjectUrl(charactersApi.illustrationFileUrl(
      presentation.characterName,
      desired.name,
    )).then(async (url) => {
      if (!url) return;
      try {
        await loadImage(url);
      } catch {
        URL.revokeObjectURL(url);
        return;
      }
      if (cancelled) {
        URL.revokeObjectURL(url);
        return;
      }

      const next = { resource: desired, url };
      const previous = displayedRef.current;
      displayedRef.current = next;
      setDisplayed(next);

      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
      if (outgoingRef.current) URL.revokeObjectURL(outgoingRef.current.url);
      outgoingRef.current = previous;
      setOutgoing(previous);
      exitTimerRef.current = setTimeout(() => {
        if (outgoingRef.current) URL.revokeObjectURL(outgoingRef.current.url);
        outgoingRef.current = null;
        setOutgoing(null);
        exitTimerRef.current = null;
      }, 300);
    });

    return () => {
      cancelled = true;
    };
  }, [desired, presentation.characterName]);

  useEffect(() => () => {
    if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
    if (displayedRef.current) URL.revokeObjectURL(displayedRef.current.url);
    if (outgoingRef.current) URL.revokeObjectURL(outgoingRef.current.url);
  }, []);

  return (
    <div className="ema-character-stage-resource" data-state="active">
      {outgoing && <IllustrationLayer loaded={outgoing} state="outgoing" />}
      {displayed && <IllustrationLayer loaded={displayed} state="active" />}
    </div>
  );
}

interface LoadedIllustration {
  readonly resource: CharacterIllustrationStageEntry;
  readonly url: string;
}

function IllustrationLayer({
  loaded,
  state,
}: {
  loaded: LoadedIllustration;
  state: 'active' | 'outgoing';
}): JSX.Element {
  return (
    <div
      className="ema-character-stage-illustration-layer"
      data-state={state}
      style={resourceTransform(loaded.resource)}
    >
      <img
        src={loaded.url}
        alt={loaded.resource.displayName}
        className="ema-character-stage-portrait"
        draggable={false}
      />
    </div>
  );
}

function listenForIllustrationEmotion(
  presentation: Extract<CharacterStagePresentation, { status: 'illustration' }>,
  setResource: Dispatch<SetStateAction<CharacterIllustrationStageEntry>>,
): () => void {
  let disposed = false;
  const unlisten = tauriBridge.listenStageEmotion((emotion) => {
    const pool = presentation.expressions[emotion];
    if (!pool?.length) return;
    setResource((current) => {
      const choices = pool.length > 1
        ? pool.filter(candidate => candidate.name !== current.name)
        : pool;
      return choices[Math.floor(Math.random() * choices.length)] ?? current;
    });
  });

  return () => {
    disposed = true;
    void unlisten.then((stop) => {
      if (disposed) stop();
    });
  };
}

function loadImage(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('立绘解码失败'));
    image.src = url;
  });
}

function resourceTransform(
  resource: CharacterLive2dStageEntry | CharacterIllustrationStageEntry,
): React.CSSProperties {
  return {
    transform: `translate(${resource.stageOffsetX * 100}%, ${resource.stageOffsetY * 100}%) scale(${resource.stageScale})`,
  };
}
