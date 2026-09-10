// 把 Character 返回的模型 ZIP 交给 pixi-live2d-display 的文件加载链。

import JSZip from 'jszip';
import {
  Cubism4InternalModel,
  Live2DFactory,
  Live2DModel,
  ZipLoader,
  type Live2DFactoryOptions,
} from 'pixi-live2d-display/cubism4';

type Cubism4Model = Live2DModel<Cubism4InternalModel>;

// pixi-live2d-display 只定义 ZIP 读取接口,具体解包器由宿主注入. 这些回调让它把
// model3.json 及其引用文件全部解析为浏览器 blob URL,不再触碰宿主文件路径.
ZipLoader.zipReader = data => JSZip.loadAsync(data);
ZipLoader.getFilePaths = reader => Promise.resolve(
  Object.values(reader.files as Record<string, JSZip.JSZipObject>)
    .filter(entry => !entry.dir)
    .map(entry => entry.name),
);
ZipLoader.getFiles = (reader, paths) => Promise.all(paths.map(async entryPath => {
  const entry = reader.file(entryPath);
  if (!entry) throw new Error(`Live2D ZIP 缺少文件: ${entryPath}`);
  const fileName = entryPath.slice(entryPath.lastIndexOf('/') + 1);
  return new File([await entry.async('blob')], fileName);
}));
ZipLoader.readText = async (reader, entryPath) => {
  const entry = reader.file(entryPath);
  if (!entry) throw new Error(`Live2D ZIP 缺少文件: ${entryPath}`);
  return entry.async('text');
};
ZipLoader.releaseReader = () => {};

export async function loadLive2DArchive(
  archive: Blob,
  options?: Live2DFactoryOptions,
): Promise<Cubism4Model> {
  const model = new Live2DModel<Cubism4InternalModel>(options);
  const archiveFile = new File([archive], 'model.zip', {
    type: 'application/zip',
  });
  // 0.5.0-beta 的实现支持单元素 File[] ZIP,但声明文件仍只列出 URL/settings.
  await Live2DFactory.setupLive2DModel(model, [archiveFile] as never, options);
  return model;
}
