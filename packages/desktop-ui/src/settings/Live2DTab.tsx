/** Live2DTab — Live2D model selection (V1 minimal). */
export function Live2DTab(): JSX.Element {
  return (
    <div>
      <h2 className="text-lg font-semibold mb-3">Live2D 模型</h2>
      <div className="text-gray-500 text-sm">
        V1 暂不支持模型上传。当前使用内置 Ema 模型。
      </div>
      <div className="mt-4 flex items-center gap-3 bg-gray-800 rounded-xl px-4 py-3 border border-gray-700">
        <div className="w-2 h-2 rounded-full bg-green-400" />
        <span className="text-sm font-medium">ema-v1</span>
        <span className="text-xs text-gray-500">内置</span>
      </div>
    </div>
  );
}
