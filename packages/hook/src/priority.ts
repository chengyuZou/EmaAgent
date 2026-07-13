/** 优先级固定档位 - 用这些常量代替魔法数字。数字小的先执行。 */
export const PRIORITY = {
  /** 系统级:角色卡注入、system prompt 基础构建。 */
  FIRST:   10,
  /** 召回阶段:记忆召回、narrative 上下文、上下文增强。 */
  EARLY:   20,
  /** 增强阶段:skill prompt 注入、mode 专属补充。 */
  NORMAL:  50,
  /** 通用 handler 默认档位。 */
  DEFAULT: 100,
  /** 后处理:审计、telemetry、清理。 */
  LATE:    200,
} as const;
