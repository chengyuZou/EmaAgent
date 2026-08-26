// 内置工具身份定义已上移到工具框架层(@ema-agent/tools), 此处仅转导出。
// 保持既有消费路径不变: 本文件的相对导入与 @ema-agent/builtin-tools 主入口、
// @ema-agent/builtin-tools/identity 子路径都继续可用。
export {
  BuiltinTools,
  type BuiltinToolIdentity,
  type BuiltinToolVariant,
} from '@ema-agent/tools/identity';
