/**
 * 前端渲染协议与 ACT 标签的类型定义。
 *
 * RenderBlock 只描述“怎么渲染一段输出”，Artifact 相关协议放在 artifacts.ts。
 */

/** 富文本渲染块联合类型 */
export type RenderBlock =
  | { type: "markdown"; text: string }
  | { type: "code"; language?: string; code: string }
  | { type: "math_inline"; latex: string }
  | { type: "math_block"; latex: string }
  | { type: "mermaid"; code: string; theme?: "dark" | "light" }
  | { type: "image"; url: string; alt?: string; width?: number; height?: number }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "file_ref"; path: string; label?: string };

/** 允许的情绪名称 */
export type EmotionName =
  | "happy"
  | "sad"
  | "angry"
  | "think"
  | "surprised"
  | "awkward"
  | "question"
  | "curious"
  | "neutral";

/** ACT 标签状态 */
export interface ActState {
  emotion: {
    name: EmotionName;
    intensity: number;
  };
  cognitive: string;
  intent: string;
  motion: string;
}
