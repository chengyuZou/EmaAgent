// 将节点当前描述与本批增量证据组织成 Memory 归并模型提示词。

export function buildConsolidationPrompt(args: {
  label: string;
  nodeType: string;
  currentDescription: string;
  fragments: readonly string[];
}): string {
  return `You are merging new factual fragments into an existing memory node.

Node:
  label:        ${args.label}
  type:         ${args.nodeType}
  description:  ${args.currentDescription || '(empty)'}

New fragments to integrate:
${args.fragments.map((fragment, index) => `  ${index + 1}. ${fragment}`).join('\n')}

Produce an updated description that:
  - preserves still-relevant existing information
  - integrates the new fragments without redundancy
  - is concise and factual (no narration, no markdown)
  - flags contradictions when present ("previously X, now reports Y")

Respond with a single JSON object — no prose, no fences:
{
  "updated_description": string,
  "importance_delta":    -20 to +20
}`;
}
