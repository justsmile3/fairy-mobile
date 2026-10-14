/**
 * agent.js —— 工具调用循环
 *
 * 把「模型决定调用工具 → 宿主执行 → 结果回传 → 模型继续」这个循环
 * 封装起来，让对话主流程只需要调用一次。
 *
 * 为什么要单独一层：
 *   工具循环涉及多轮请求、消息拼接、上限控制与失败处理，
 *   混在 sendMessage 里会让那段代码难以阅读，也不好测试。
 *
 * 关键约束：
 *   - **轮数上限**。模型可能反复调用同一个工具（尤其在工具一直失败时），
 *     无上限会导致请求风暴与费用失控。
 *   - **工具结果如实回传**。失败也要回传，模型看到失败往往能换一种做法；
 *     若把失败吞掉，模型会以为成功了，接着编造结果 —— 比报错更糟。
 *   - **流式输出保留**。工具调用之间的正文依然边生成边显示，
 *     不让用户对着空白等待。
 */

import { TOOL_DEFINITIONS, createToolRunner, formatToolResult } from './tools.js';
import { normalizeToolCalls } from './api.js';

/** 最多允许几轮工具调用。超过后强制要求模型直接作答。 */
const MAX_TOOL_ROUNDS = 5;

/**
 * 运行一次带工具的对话。
 *
 * @param {object} opts
 * @param {object} opts.params        传给 streamChat 的基础参数（apiKey/baseUrl/model/...）
 * @param {Array}  opts.messages      初始 messages（含 system prompt）
 * @param {object} opts.handlers      流式回调：onContent / onReasoning / onUsage / onToolActivity
 * @param {object} opts.runner        工具执行器（createToolRunner 的返回值）
 * @param {AbortSignal} opts.signal
 * @returns {Promise<{content:string, toolRounds:number, stopped:'done'|'max-rounds'|'tools-unavailable'>}
 */
export async function runWithTools(opts, streamChat, streamHandlers = {}) {
  const { params, messages, handlers = {}, runner, signal } = opts;

  // 合并两处回调：opts.handlers（工具循环内部使用）与 streamHandlers（主流程传入）
  const cb = { ...handlers, ...streamHandlers };

  // 没有原生桥时不注册工具 —— 注册了也执行不了，
  // 模型会调用、拿到"不支持"，白费一轮请求
  const nativeOk = runner && typeof runner.hasNative === 'function' ? runner.hasNative() : false;
  const tools = nativeOk ? TOOL_DEFINITIONS : null;

  let working = messages.slice();
  let finalContent = '';
  let rounds = 0;

  for (;;) {
    if (signal?.aborted) break;

    const collected = await streamChat({
      ...params,
      messages: working,
      tools,
    }, cb, signal);

    const text = collected?.content || '';
    const calls = normalizeToolCalls(collected);

    // 没有工具调用：本轮就是最终答复
    if (!calls.length || !nativeOk) {
      finalContent += text;
      return { content: finalContent, toolRounds: rounds, stopped: 'done' };
    }

    // 模型可能既输出了正文、又要求调用工具（"我先查一下"）。
    // 这段正文要保留并展示，但不要重复累加到最终答复里 ——
    // 因为下一轮它还会再生成一次完整回答。
    if (text && typeof cb.onToolActivity === 'function') {
      cb.onToolActivity({ type: 'note', text });
    }

    // 达到轮数上限：不再执行工具，要求模型直接作答
    if (rounds >= MAX_TOOL_ROUNDS) {
      working = working.concat(
        { role: 'assistant', content: text || null, tool_calls: calls.map(toApiToolCall) },
        ...calls.map((c) => ({
          role: 'tool',
          tool_call_id: c.id,
          content: '已达到本轮工具调用上限，请直接根据已有信息回答。',
        })),
        { role: 'user', content: '请直接回答，不要再调用工具。' },
      );
      const last = await streamChat({ ...params, messages: working, tools: null }, cb, signal);
      finalContent += last?.content || '';
      return { content: finalContent, toolRounds: rounds, stopped: 'max-rounds' };
    }

    rounds += 1;

    // 把模型的工具调用意图记进消息，再逐条追加执行结果
    working = working.concat({
      role: 'assistant',
      content: text || null,
      tool_calls: calls.map(toApiToolCall),
    });

    for (const call of calls) {
      if (signal?.aborted) break;

      // 参数解析失败：如实回传，让模型知道自己的 JSON 写错了
      if (call.parseError) {
        working = working.concat({
          role: 'tool',
          tool_call_id: call.id,
          content: `工具调用失败：${call.parseError}`,
        });
        continue;
      }

      if (typeof cb.onToolActivity === 'function') {
        cb.onToolActivity({ type: 'call', name: call.name, args: call.args });
      }

      const result = await runner.run(call.name, call.args);
      const formatted = formatToolResult(call.name, result);

      if (typeof cb.onToolActivity === 'function') {
        cb.onToolActivity({ type: 'result', name: call.name, ok: Boolean(result?.ok), text: formatted });
      }

      working = working.concat({
        role: 'tool',
        tool_call_id: call.id,
        content: formatted,
      });
    }

    // 循环继续：让模型带着工具结果生成下一轮
  }

  return { content: finalContent, toolRounds: rounds, stopped: 'done' };
}

function toApiToolCall(call) {
  return {
    id: call.id,
    type: 'function',
    function: {
      name: call.name,
      arguments: JSON.stringify(call.args ?? {}),
    },
  };
}

export { TOOL_DEFINITIONS, createToolRunner };
