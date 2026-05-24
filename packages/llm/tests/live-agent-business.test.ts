import { describe, it, expect } from 'vitest';
import { LlmRouter } from '../src/router.js';
import type { LlmRequest, ProviderConfig, LlmMessage, LlmToolDef } from '../src/types.js';

const ALIYUN_CONFIG: ProviderConfig = {
  id: 'aliyun',
  protocol: 'openai-llm',
  apiKey: 'sk-44',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
};

const router = new LlmRouter([ALIYUN_CONFIG]);

// ── 工具：模拟真实业务系统的后台 API ──────────────────────────────────────────

/** 业务工具 1：查询订单信�?*/
const ORDER_TOOL: LlmToolDef = {
  name: 'query_order',
  description: '根据订单号查询订单的状态、商品、金额、收货地址等信息�?,
  parameters: {
    type: 'object',
    properties: {
      orderId: { type: 'string', description: '订单号，例如 ORD-20240511-001' },
    },
    required: ['orderId'],
  },
};

/** 业务工具 2：查询库�?*/
const INVENTORY_TOOL: LlmToolDef = {
  name: 'check_inventory',
  description: '查询指定 SKU 在当前仓库的实时库存数量�?,
  parameters: {
    type: 'object',
    properties: {
      sku: { type: 'string', description: '商品 SKU 编码' },
      warehouse: { type: 'string', description: '仓库编码，例�?WH-SH-01' },
    },
    required: ['sku', 'warehouse'],
  },
};

/** 业务工具 3：发起退�?*/
const REFUND_TOOL: LlmToolDef = {
  name: 'create_refund',
  description: '为指定订单创建退款申请。退款金额不可超过订单实付金额�?,
  parameters: {
    type: 'object',
    properties: {
      orderId: { type: 'string', description: '要退款的订单�? },
      amount: { type: 'number', description: '退款金额（元）' },
      reason: { type: 'string', description: '退款原�? },
    },
    required: ['orderId', 'amount', 'reason'],
  },
};

/** 业务工具 4：识别收�?发票并记�?*/
const BOOK_INVOICE_TOOL: LlmToolDef = {
  name: 'book_invoice',
  description: '将识别后的发票信息录入财务系统，返回凭证号�?,
  parameters: {
    type: 'object',
    properties: {
      invoiceNumber: { type: 'string', description: '发票号码' },
      amount: { type: 'number', description: '发票金额（元�? },
      vendor: { type: 'string', description: '开票方/供应商名�? },
      date: { type: 'string', description: '发票日期，格�?YYYY-MM-DD' },
    },
    required: ['invoiceNumber', 'amount', 'vendor', 'date'],
  },
};

// ── 模拟工具执行器（支持异步，模拟真�?I/O 延迟�?──────────────────────────

/** 模拟后台系统，根�?tool name 返回对应的假数据 */
async function executeTool(toolName: string, args: Record<string, unknown>): Promise<string> {
  // 🔥 模拟真实业务 I/O 延迟：查订单 300ms，查库存 500ms，退�?800ms，记�?200ms
  const delays: Record<string, number> = {
    query_order: 300,
    check_inventory: 500,
    create_refund: 800,
    book_invoice: 200,
  };
  await new Promise(r => setTimeout(r, delays[toolName] ?? 100));

  switch (toolName) {
    case 'query_order':
      return JSON.stringify({
        orderId: args.orderId,
        status: '已发�?,
        items: [{ sku: 'SKU-8891', name: '无线降噪耳机', quantity: 1, price: 299 }],
        totalAmount: 299,
        address: '广东省深圳市南山区科技�?,
      });

    case 'check_inventory':
      return JSON.stringify({
        sku: args.sku,
        warehouse: args.warehouse,
        stock: args.sku === 'SKU-8891' ? 42 : 0,
        unit: '�?,
      });

    case 'create_refund':
      return JSON.stringify({
        refundId: `RFND-${Date.now()}`,
        orderId: args.orderId,
        amount: args.amount,
        status: '已提交，预计3-5个工作日到账',
      });

    case 'book_invoice':
      return JSON.stringify({
        voucherId: `VCH-${Date.now().toString(36).toUpperCase()}`,
        invoiceNumber: args.invoiceNumber,
        amount: args.amount,
        status: '已入�?,
      });

    default:
      return JSON.stringify({ error: `未知工具: ${toolName}` });
  }
}

// ── 通用 Agent 循环辅助函数 ──────────────────────────────────────────────────

/**
 * 🚀 Fire-and-Gather 风格�?Agent 循环�?
 * - 流式打字机输出文本的同时继续运行
 * - tool_use_delta: 实时显示参数累积过程（用 . 表示�?
 * - tool_use_complete: 🔥 不阻塞！立即 fire 异步任务（类似于扔给子线�?MCP），
 *   主循环继续获取后�?chunk，整�?stream 跑完后统一 await Promise.all 收集结果
 * - 效果：即使某个工�?delay 很久，也不影响流式文本的实时输出
 *
 * 这类似于 Python �?asyncio.gather()�?
 *   tasks = [asyncio.create_task(run_tool(...)) for ...]
 *   results = await asyncio.gather(*tasks)
 */
async function agentLoop(
  model: string,
  initialMessages: LlmMessage[],
  tools: LlmToolDef[],
  maxTurns = 5,
): Promise<{ finalAnswer: string; allToolCalls: Array<{ name: string; args: unknown }> }> {
  const messages = [...initialMessages];
  const allToolCalls: Array<{ name: string; args: unknown }> = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    let assistantText = '';

    // 🔥 存放"�?fire 出去正在后台�?�?Promise（类�?Python �?asyncio.Task�?
    const toolPromises: Array<Promise<{
      callId: string; name: string; args: unknown; result: string;
    }>> = [];

    let buildingToolName = '';

    const request: LlmRequest = {
      providerId: 'aliyun',
      model,
      messages,
      tools,
      toolChoice: 'auto',
      maxTokens: 800,
    };

    console.log(`\n📡 [Agent �?{turn + 1}轮] 开始流式接�?LLM 响应...`);
    for await (const chunk of router.stream(request)) {
      if (chunk.type === 'text_delta') {
        assistantText += chunk.delta;
        process.stdout.write(chunk.delta); // 实时打字机输�?
      } else if (chunk.type === 'tool_use_delta') {
        // 参数累积中…像 Claude 一样显示工具参数构建过�?
        if (chunk.name && chunk.name !== buildingToolName) {
          buildingToolName = chunk.name;
        }
        process.stdout.write('.'); // 用点表示参数在累�?
      } else if (chunk.type === 'tool_use_complete') {
        // 🔥 Fire-and-Forget：立�?fire 异步任务，不 await�?
        //    效果等同�?Python: asyncio.create_task(run_tool(...))
        //    主循环继续往下取 chunk，绝不卡�?
        process.stdout.write('\n');
        console.log(
          `🔥 [Agent �?{turn + 1}轮] Fire 异步任务: ` +
          `${chunk.name}(${JSON.stringify(chunk.args)}) �?后台执行�?..`,
        );

        // 捕获 callId/name/args，同�?fire Promise
        const callId = chunk.callId;
        const name = chunk.name;
        const args = chunk.args;

        toolPromises.push(
          executeTool(name, args as Record<string, unknown>).then(result => {
            console.log(`   �?[完成] ${name} 返回: ${result.slice(0, 80)}`);
            return { callId, name, args, result };
          }),
        );
      }
    }
    process.stdout.write('\n');

    // 流结束：如果本轮没有工具调用，对话结�?
    if (toolPromises.length === 0) {
      return { finalAnswer: assistantText, allToolCalls };
    }

    // 🔥 Gather 阶段：统一等待所有后台工具任务完�?
    //    效果等同�?Python: results = await asyncio.gather(*tasks)
    console.log(`�?[Agent �?{turn + 1}轮] 等待 ${toolPromises.length} 个后台工具任务完�?..`);
    const completedTools = await Promise.all(toolPromises);
    console.log(`�?[Agent �?{turn + 1}轮] 全部 ${completedTools.length} 个工具任务已返回`);

    // �?assistant 消息 + 收集好的 tool 结果拼回消息历史
    messages.push({
      role: 'assistant',
      content: assistantText || null,
      toolCalls: completedTools.map(tc => ({
        id: tc.callId,
        name: tc.name,
        args: tc.args,
      })),
    });

    for (const tc of completedTools) {
      allToolCalls.push({ name: tc.name, args: tc.args });
      messages.push({
        role: 'tool',
        toolCallId: tc.callId,
        content: tc.result,
      });
    }
  }

  throw new Error(`Agent 循环超过最大轮�?${maxTurns}，可能陷入工具死循环`);
}

// ══════════════════════════════════════════════════════════════════════════════�?
//   测试套件：面向真实业务场景的 Agent 调用
// ══════════════════════════════════════════════════════════════════════════════�?

describe.only('Real-Business Agent Tests: Multi-Tool, Image+Tool, Pure Text', () => {

  // ── 场景 1：多工具串联调用（客服查订单 �?查库�?�?总结�?─────────────────
  it('should chain multiple tools in agent loop for order inquiry', async () => {
    console.log('\n━━�?场景 1: 多工具串�?━━�?);
    console.log('用户: "帮我查一下订�?ORD-20240511-001 的状态，以及里面商品的库存情�?');

    const messages: LlmMessage[] = [
      {
        role: 'system',
        content:
          '你是一个电商客服助手。当用户查询订单时，你必须先�?query_order 查询订单详情�? +
          '然后对订单中的每个商品用 check_inventory 查询库存。最后综合给出简洁总结�?,
      },
      { role: 'user', content: '帮我查一下订�?ORD-20240511-001 的状态，以及里面商品的库存情况�? },
    ];

    const { finalAnswer, allToolCalls } = await agentLoop(
      'qwen-plus',
      messages,
      [ORDER_TOOL, INVENTORY_TOOL],
    );

    // 验证至少调用�?query_order �?check_inventory
    const toolNames = allToolCalls.map(tc => tc.name);
    expect(toolNames).toContain('query_order');
    expect(toolNames).toContain('check_inventory');
    expect(allToolCalls.length).toBeGreaterThanOrEqual(2);

    // 验证最终回复包含关键信�?
    expect(finalAnswer).toMatch(/ORD-20240511-001|已发货|库存|42|SKU-8891|无线降噪/);
  }, 60000);

  // ── 场景 2：退款处理（多工�?+ 条件判断�?─────────────────────────────────
  it('should handle refund workflow with conditional tool use', async () => {
    console.log('\n━━�?场景 2: 退款工作流 ━━�?);
    console.log('用户: "订单 ORD-20240511-001 收到的耳机有杂音，我要退�?');

    const messages: LlmMessage[] = [
      {
        role: 'system',
        content:
          '你是一个电商售后客服。退款流程：1) 先用 query_order 确认订单存在且状态允许退款；' +
          '2) 确认后调�?create_refund 发起退款（金额以订单实付为准）。如果订单状态为"已退�?则告知用户已退过�?,
      },
      {
        role: 'user',
        content: '订单 ORD-20240511-001 收到的耳机有杂音，我要退款�?,
      },
    ];

    const { finalAnswer, allToolCalls } = await agentLoop(
      'qwen-plus',
      messages,
      [ORDER_TOOL, REFUND_TOOL],
    );

    // 验证调用�?query_order �?create_refund
    const toolNames = allToolCalls.map(tc => tc.name);
    expect(toolNames).toContain('query_order');
    expect(toolNames).toContain('create_refund');
    expect(allToolCalls.length).toBeGreaterThanOrEqual(2);

    // 最终回复应提到退�?
    expect(finalAnswer).toMatch(/退款|refund|Refund|到账|提交/);
  }, 60000);

  // ── 场景 3：Fire-and-Gather 并行工具（同一轮内并发查多个库存） ─────────
  it('should fire-and-gather multiple tools in parallel within same turn', async () => {
    console.log('\n━━�?场景 3: Fire-and-Gather 并行工具 ━━�?);
    console.log('用户: "同时�?SKU-8891、SKU-9999、SKU-1000 �?WH-SH-01 的库�?');

    // 🔥 核心展示：prompt 要求模型「一次性」调用多�?check_inventory
    const messages: LlmMessage[] = [
      {
        role: 'system',
        content:
          '你是一个库存管理助手。当用户要求批量查询库存时，你必须在同一轮中一次性调用多�?check_inventory�? +
          '每个 SKU 调用一次，不要逐轮逐个查询。调用完所有工具后再汇总回复�?,
      },
      {
        role: 'user',
        content:
          '请同时查询以�?3 �?SKU �?WH-SH-01 仓库的库存：SKU-8891、SKU-9999、SKU-1000。一次性全查，不要逐轮查�?,
      },
    ];

    const startMs = Date.now();
    const { finalAnswer, allToolCalls } = await agentLoop(
      'qwen-plus',
      messages,
      [INVENTORY_TOOL],
    );
    const costMs = Date.now() - startMs;

    // 🔥 验证：至少调用了 3 �?check_inventory（每�?SKU 一次）
    const inventoryCalls = allToolCalls.filter(tc => tc.name === 'check_inventory');
    expect(inventoryCalls.length).toBeGreaterThanOrEqual(3);

    // 🔥 如果在一轮内并行 fire，总耗时 �?max(各工具延�? 而非 sum(延迟)
    //    每个 check_inventory 延迟 500ms�? 个并�?fire �?500ms，串行需�?1500ms
    console.log(
      `⏱️  ${inventoryCalls.length} �?check_inventory 总耗时: ${costMs}ms ` +
      `(并行 fire �?500ms vs 串行�?${inventoryCalls.length * 500}ms)`,
    );

    // 验证最终回复包含库存相关信�?
    expect(finalAnswer).toMatch(/SKU-8891|42|SKU-9999|SKU-1000|库存/);
  }, 60000);

  // ── 场景 4：分析报告图�?+ 数据查询工具联动 ─────────────────────────────
  it('should analyze chart image and query related data via tool', async () => {
    console.log('\n━━�?场景 4: 图表图片分析 + 数据工具联动 ━━�?);
    console.log('用户: 上传一张图表，要求分析趋势并查询对�?SKU 库存');

    // 使用一张图表类图片
    const chartImageUrl =
      'https://img1.baidu.com/it/u=2246695285,2988372152&fm=253&fmt=auto&app=138&f=PNG?w=500&h=300';

    const messages: LlmMessage[] = [
      {
        role: 'system',
        content:
          '你是一个数据分析助手。用户会上传一张图表图片。你先分析图中内容，' +
          '如果图中提到了某个商�?产品，请�?check_inventory 查询其库存（仓库默认 WH-SH-01），' +
          '然后给出综合分析�?,
      },
      {
        role: 'user',
        content: [
          { type: 'image_url', url: chartImageUrl },
          { type: 'text', text: '分析这张图表，如果涉及具体产品，顺便查一下深圳仓的库存�? },
        ],
      },
    ];

    const { finalAnswer, allToolCalls } = await agentLoop(
      'qwen-vl-plus',
      messages,
      [INVENTORY_TOOL],
    );

    // 模型至少应给出图文分析回�?
    expect(finalAnswer.length).toBeGreaterThan(1);

    // 如果模型从图中识别出产品并调用了库存工具
    if (allToolCalls.length > 0) {
      expect(allToolCalls.map(tc => tc.name)).toContain('check_inventory');
      console.log(`�?模型分析了图表并调用�?check_inventory 工具`);
    } else {
      console.log('ℹ️ 模型未识别到具体产品，给出了纯文本分�?);
    }
  }, 60000);

  // ── 场景 5：纯文本对话（无工具�?─────────────────────────────────────────
  it('should handle pure text conversation without any tools', async () => {
    console.log('\n━━�?场景 5: 纯文本对话（无工具） ━━�?);
    console.log('用户: "请用三句话总结大语言模型的工作原�?');

    const messages: LlmMessage[] = [
      {
        role: 'system',
        content: '你是一个知识渊博的 AI 助手。回答要简洁、专业�?,
      },
      {
        role: 'user',
        content: '请用三句话总结大语言模型的工作原理�?,
      },
    ];

    const request: LlmRequest = {
      providerId: 'aliyun',
      model: 'qwen-plus',
      messages,
      maxTokens: 400,
    };

    let answer = '';

    console.log('🤖 [流式文本] 模型回复:');
    for await (const chunk of router.stream(request)) {
      if (chunk.type === 'text_delta') {
        answer += chunk.delta;
        process.stdout.write(chunk.delta);
      }
    }
    process.stdout.write('\n');

    // 纯文本场景最基本的断言：有内容输出
    expect(answer.length).toBeGreaterThan(20);

    // 内容应涉�?LLM 相关概念
    expect(answer).toMatch(/Transformer|注意力|预测|训练|概率|token|参数|神经网络/);
  }, 40000);

  // ── 场景 6：纯文本 + 角色扮演（无工具�?─────────────────────────────────
  it('should handle role-play text conversation', async () => {
    console.log('\n━━�?场景 6: 角色扮演纯文�?━━�?);
    console.log('用户: "请你扮演一个严厉的代码审查员，评价以下代码"');

    const codeSnippet = `
function getUserData(id) {
  var data = db.query("SELECT * FROM users WHERE id = " + id);
  return data;
}
    `.trim();

    const messages: LlmMessage[] = [
      {
        role: 'system',
        content:
          '你是一个有 15 年经验的高级代码审查员。你的审查风格：一针见血、不留情面，' +
          '但每指出一个问题必须附带改进方案。用中文回答�?,
      },
      {
        role: 'user',
        content: `请审查以下代码：\n\`\`\`javascript\n${codeSnippet}\n\`\`\``,
      },
    ];

    const request: LlmRequest = {
      providerId: 'aliyun',
      model: 'qwen-plus',
      messages,
      maxTokens: 500,
      temperature: 0.7,
    };

    let review = '';

    console.log('🔍 [流式文本] 审查结果:');
    for await (const chunk of router.stream(request)) {
      if (chunk.type === 'text_delta') {
        review += chunk.delta;
        process.stdout.write(chunk.delta);
      }
    }
    process.stdout.write('\n');

    expect(review.length).toBeGreaterThan(30);

    // 审查意见应提及代码中的常见问�?
    expect(review).toMatch(/SQL|注入|var|const|let|参数化|预编译|prepared|类型|TypeScript/);
  }, 40000);

});