import { createRef } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import {
  FileLoader,
  Live2DFactory,
  MotionPriority,
  type CubismInternalModel,
  type Live2DModel,
} from '@laplace.live/pixijs-live2d';
import {
  Live2DStage,
  type Live2DStageHandle,
  type Live2DStageReadyInfo,
} from '../../../src/live2d-react/index.js';
import { renderLive2dPreview } from '../src/settings/character/live2dPreview.js';

type CubismModel = Live2DModel<CubismInternalModel>;

const host = document.getElementById('root')!;
let root = createRoot(host);
const handle = createRef<Live2DStageHandle>();
const models: CubismModel[] = [];
const errors: string[] = [];
const objectURLs = new Set<string>();
const createObjectURL = URL.createObjectURL.bind(URL);
const revokeObjectURL = URL.revokeObjectURL.bind(URL);

URL.createObjectURL = blob => {
  const url = createObjectURL(blob);
  objectURLs.add(url);
  return url;
};
URL.revokeObjectURL = url => {
  objectURLs.delete(url);
  revokeObjectURL(url);
};

Live2DFactory.live2DModelMiddlewares.unshift(async (context, next) => {
  await next();
  models.push(context.live2dModel as CubismModel);
});
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)));

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function waitUntil(predicate: () => boolean): Promise<void> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > 20_000) throw new Error('Model frame condition timed out');
    await sleep(50);
  }
}

async function verifyModel(name: string) {
  const previousModel = models.at(-1);
  const archive = await fetch(`/model.zip?name=${encodeURIComponent(name)}`).then(response => response.blob());
  const preview = await renderLive2dPreview(archive);
  const image = new Image();
  image.src = `data:image/png;base64,${preview}`;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d')!;
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height).data;
  let previewPixels = 0;
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index]! > 0) previewPixels++;
  }
  if (previewPixels < 10_000) throw new Error(`Empty preview: ${previewPixels}`);

  const ready = await new Promise<Live2DStageReadyInfo>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Stage ready timed out')), 20_000);
    root.render(
      <Live2DStage
        ref={handle}
        modelArchive={archive}
        pointerSource="host"
        onReady={value => {
          clearTimeout(timeout);
          resolve(value);
        }}
        onError={error => {
          clearTimeout(timeout);
          errors.push(error.message);
          reject(error);
        }}
      />,
    );
  });
  const model = models.at(-1)!;
  const internal = model.internalModel;
  const motions = Object.entries(internal.settings.motions ?? {});
  const motion = motions.find(([group, items]) => group !== 'Idle' && items.length > 0)
    ?? motions.find(([, items]) => items.length > 0);
  // The library rejects a request for the same randomly selected idle that is already playing.
  internal.motionManager.stopAllMotions();
  const motionStarted = motion
    ? await model.motion(motion[0], 0, MotionPriority.FORCE, { volume: 0 })
    : null;
  if (motion && !motionStarted) throw new Error('Defined motion did not start');

  const expressionManager = internal.motionManager.expressionManager;
  for (const expression of ready.expressions.slice(0, 2)) {
    handle.current!.setExpression(expression);
    await expressionManager!.loadExpression(expressionManager!.getExpressionIndex(expression));
    await waitUntil(() => expressionManager!.activeExpressionNames().includes(expression));
    if (expressionManager!.activeExpressionNames().length !== 1) throw new Error('Expressions accumulated');
  }
  handle.current!.setExpression(null);
  // A permanent clear must not restore the previous expression after a motion finishes.
  await expressionManager?.restoreExpression();
  if (expressionManager?.activeExpressionNames().length) throw new Error('Cleared expression returned');

  handle.current!.setPointerPosition(370, 40);
  const ids = internal.settings.getLipSyncParameters() ?? [];
  const parameters = internal.coreModel.getModel().parameters;
  const indices = ids.map(id => parameters.ids.indexOf(id)).filter(index => index >= 0);
  let mouthValues: number[] = [];
  // Cubism restores saved parameters after updating drawable vertices. Read our writes before that reset.
  const captureMouth = (): void => {
    mouthValues = indices.map(index => internal.coreModel.getParameterValueByIndex(index));
  };
  internal.on('beforeModelUpdate', captureMouth);
  handle.current!.setLipSync(true, 1);
  if (indices.length) await waitUntil(() => mouthValues.some(value => value > 0.7));
  const openValues = mouthValues;
  handle.current!.setLipSync(false, 0);
  if (indices.length) await waitUntil(() => mouthValues.length > 0 && mouthValues.every(value => value < 0.2));
  const closedValues = mouthValues;
  internal.off('beforeModelUpdate', captureMouth);
  if (previousModel && !previousModel.destroyed) throw new Error('Previous model was not destroyed');
  if (errors.length) throw new Error(errors.join('\n'));
  return {
    name,
    previewWidth: image.width,
    previewHeight: image.height,
    previewPixels,
    motionStarted,
    expressions: ready.expressions.length,
    lipSyncParameters: indices.length,
    openValues,
    closedValues,
    canvasCount: host.querySelectorAll('canvas').length,
  };
}

async function verifyCleanup() {
  root.unmount();
  await sleep(150);
  if (host.querySelectorAll('canvas').length) throw new Error('Canvas remained after unmount');
  if (objectURLs.size || Object.keys(FileLoader.filesMap).length) throw new Error('Archive URLs remained after unmount');
  if (models.some(model => !model.destroyed)) throw new Error('A loaded model was not destroyed');

  let rejected = false;
  try {
    const broken = await fetch('/model.zip?name=Broken').then(response => response.blob());
    await renderLive2dPreview(broken);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("doesn't exist in given files")) throw error;
    rejected = true;
  }
  if (!rejected) throw new Error('Broken archive unexpectedly loaded');
  if (objectURLs.size || Object.keys(FileLoader.filesMap).length) throw new Error('Failed import leaked archive URLs');

  root = createRoot(host);
  const archive = await fetch('/model.zip?name=Ema').then(response => response.blob());
  flushSync(() => root.render(<Live2DStage modelArchive={archive} onError={error => errors.push(error.message)} />));
  root.unmount();
  await sleep(500);
  if (host.querySelectorAll('canvas').length || objectURLs.size) throw new Error('Async initialization leaked resources');
  if (errors.length) throw new Error(errors.join('\n'));
  return { objectURLs: objectURLs.size, allModelsDestroyed: true, failedImportClean: true, asyncUnmountClean: true };
}

declare global {
  interface Window {
    live2DRegression: {
      verifyModel: typeof verifyModel;
      verifyCleanup: typeof verifyCleanup;
    };
  }
}
window.live2DRegression = { verifyModel, verifyCleanup };
