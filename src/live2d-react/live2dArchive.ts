import JSZip from 'jszip';
import {
  CubismInternalModel,
  Live2DFactory,
  Live2DModel,
  Live2DPlugin,
  type Live2DFactoryOptions,
} from '@laplace.live/pixijs-live2d';
import { extensions } from 'pixi.js';

type CubismModel = Live2DModel<CubismInternalModel>;

extensions.add(Live2DPlugin);

export async function loadLive2DArchive(
  archive: Blob,
  options?: Live2DFactoryOptions,
): Promise<CubismModel> {
  const zip = await JSZip.loadAsync(archive);
  const entries = Object.values(zip.files).filter(entry => !entry.dir);
  const files = await Promise.all(entries.map(async entry => {
    const file = new File(
      [await entry.async('blob')],
      entry.name.slice(entry.name.lastIndexOf('/') + 1),
    );
    // FileLoader 按归档内路径解析嵌套 model3.json 引用的纹理, 动作和表情.
    Object.defineProperty(file, 'webkitRelativePath', { value: entry.name });
    return file;
  }));
  const model = new Live2DModel<CubismInternalModel>(options);
  try {
    await Live2DFactory.setupLive2DModel(model, files, {
      ...options,
      // ZIP 纹理使用 blob URL. 直接加载图片, 不创建额外的纹理解码 Worker.
      textureOptions: { ...options?.textureOptions, preferCreateImageBitmap: false },
    });
  } catch (cause) {
    model.destroy({ children: true, texture: true, baseTexture: true });
    throw cause;
  }
  return model;
}
