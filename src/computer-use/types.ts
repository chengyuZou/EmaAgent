import { z } from 'zod';

export const computerWindowSchema = z.object({
  // Windows 窗口句柄转成的字符串, 后续观察窗口时原样传回.
  id: z.string(),
  title: z.string(),
  // 窗口所属程序的路径. 读不到路径时返回 pid:<进程号>.
  app: z.string(),
  // 桌面物理像素坐标. 多显示器排列可能产生负的 x 或 y.
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export type ComputerWindow = z.infer<typeof computerWindowSchema>;

export const computerElementSchema = z.object({
  // 编号只在产生它的 observationId 内有效, 不是控件的永久身份.
  id: z.number().int(),
  name: z.string(),
  role: z.string(),
  enabled: z.boolean(),
  // 支持直接设置整个控件值. 真正写入时 Rust 仍会检查控件是否只读.
  editable: z.boolean(),
  invokable: z.boolean(),
  // 相对于观察截图的像素范围, 不使用桌面绝对坐标.
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export const computerObservationSchema = z.object({
  // 用户介入或窗口状态变化后作废, 新观察不会让旧编号重新有效.
  observationId: z.string(),
  // 使用启动这段控制的 ToolCallId, 同一 Turn 内跨 Loop 保持不变.
  controlId: z.string(),
  // null 表示前置成功. 失败时仍可能取得窗口图像, 不能据此认为目标已在前台.
  activationError: z.string().nullable(),
  window: computerWindowSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  // PNG 文件的 base64, 不包含 data URL 前缀.
  image: z.string(),
  mimeType: z.literal('image/png'),
  elements: z.array(computerElementSchema),
  // 未能完整读取控件时为 true, 包括达到上限或目标没有可用的无障碍接口.
  truncated: z.boolean(),
});

export type ComputerObservation = z.infer<typeof computerObservationSchema>;

// 动作坐标始终属于调用指定的观察截图, 由 Rust 还原为桌面输入坐标.
const point = {
  x: z.number(),
  y: z.number(),
};

export const computerActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('click'),
    ...point,
    button: z.enum(['left', 'right', 'middle']).default('left'),
    count: z.number().int().min(1).max(2).default(1),
  }),
  z.object({
    type: z.literal('move'),
    ...point,
  }),
  z.object({
    type: z.literal('scroll'),
    ...point,
    // 滚轮增量, 120 表示一格. 正值分别向右和向下滚动, 不是滚动像素数.
    horizontal: z.number().int().min(-12000).max(12000).default(0),
    vertical: z.number().int().min(-12000).max(12000).default(0),
  }),
  z.object({
    type: z.literal('drag'),
    ...point,
    toX: z.number(),
    toY: z.number(),
    // 完成拖拽路径的时间, 单位毫秒. 中断时仍须释放已按住的鼠标按钮.
    durationMs: z.number().int().min(100).max(5000).default(500),
  }),
  z.object({
    type: z.literal('type'),
    // 在已聚焦的位置输入文本. 按键命令使用 key 动作.
    text: z.string().max(20000),
  }),
  z.object({
    type: z.literal('key'),
    // 使用 + 分隔的组合键, 例如 Ctrl+A. 按下和松开在同一次动作内完成.
    keys: z.string().min(1).max(100),
  }),
  z.object({
    type: z.literal('setValue'),
    elementId: z.number().int().nonnegative(),
    // 替换控件的完整值, 不表示在光标处追加.
    text: z.string().max(20000),
  }),
  z.object({
    type: z.literal('invoke'),
    elementId: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('focus'),
    elementId: z.number().int().nonnegative(),
  }),
]);

export type ComputerAction = z.infer<typeof computerActionSchema>;

export const actionResultSchema = z.object({
  status: z.enum([
    'completed',
    'observation_expired',
    'control_ended',
    'interrupted',
  ]),
  // none 表示尚未提交输入或控件操作. possible 表示可能已经影响目标应用, 失败时不能直接重试.
  effect: z.enum(['none', 'possible']),
  message: z.string(),
});

export type ComputerActionResult = z.infer<typeof actionResultSchema>;

export const controlEventSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.literal('computer.stateChanged'),
  params: z.object({
    controlId: z.string(),
    // ending 表示不再接受新输入, 但可能还在松开按键或等 Windows 调用结束.
    // 收到 ended 才表示这次电脑操控已经结束.
    phase: z.enum(['running', 'ending', 'ended']),
    reason: z.enum([
      'started',
      'user_end',
      'agent_end',
      'cancelled',
      'connection_closed',
    ]),
  }),
});

export type NativeControlState = z.infer<typeof controlEventSchema>['params'];

export type NativeRequest =
  | {
    method: 'computer.listWindows';
    params: Record<string, never>;
  }
  | {
    method: 'computer.begin';
    params: { controlId: string };
  }
  | {
    method: 'computer.observe';
    params: { controlId: string; windowId: string };
  }
  | {
    method: 'computer.act';
    params: {
      controlId: string;
      observationId: string;
      action: ComputerAction;
    };
  }
  | {
    method: 'computer.end';
    params: { controlId: string; reason: 'agent_end' | 'cancelled' };
  }
  | {
    method: 'computer.capture';
    params: Record<string, never>;
  };

export interface ComputerTransport {
  // 发出一条请求, 等 Rust 返回这条请求的结果. 取消时通知 Rust 停止该请求.
  request(request: NativeRequest, signal: AbortSignal): Promise<unknown>;
  // Rust 会主动通知启动和结束, 不必等某个请求完成. 返回的函数用来取消监听.
  subscribe(listener: (state: NativeControlState) => void): () => void;
  close(): Promise<void>;
}

