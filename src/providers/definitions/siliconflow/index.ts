import { defineProvider } from '../../types.js';
import { siliconFlowEmbedding } from './embedding.js';
import { siliconFlowLlm } from './llm.js';
import { siliconFlowRerank } from './rerank.js';
import { siliconFlowStt } from './stt.js';
import { siliconFlowTts } from './tts.js';
import { siliconFlowVision } from './vision.js';

export const provider = defineProvider({
  id: 'siliconflow',
  name: 'SiliconFlow',
  branding: { iconId: 'siliconflow' },
  connection: {
    defaultBaseUrl: 'https://api.siliconflow.cn/v1',
    auth: { type: 'bearer', required: true },
  },
  capabilities: {
    llm: siliconFlowLlm,
    embed: siliconFlowEmbedding,
    rerank: siliconFlowRerank,
    vision: siliconFlowVision,
    tts: siliconFlowTts,
    stt: siliconFlowStt,
  },
});
