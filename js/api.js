/**
 * api.js —— DeepSeek API 客户端（纯浏览器，直连官方接口）
 *
 * 关键事实：api.deepseek.com 会回显请求的 Origin 并允许 authorization 头，
 * 因此浏览器可以直连，无需任何中转服务器。
 *
 * 支持：SSE 流式对话（含 reasoning_content）、模型列表、账户余额。
 */

export class ApiError extends Error {
  constructor(message, { status = 0, code = '', cause = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.cause = cause;
  }
}

export function normalizeBaseUrl(input) {
  const raw = String(input || '').trim() || 'https://api.deepseek.com';
  return raw.replace(/\/+$/, '').replace(/\/v1$/, '');
}

function authHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${String(apiKey || '').trim()}`,
  };
}

/** 把 HTTP 状态与响应体翻译成给用户看的中文提示 */
function describeHttpError(status, bodyText) {
  let detail = '';
  try {
    const parsed = JSON.parse(bodyText);
    detail = parsed?.error?.message || parsed?.message || '';
  } catch {
    detail = String(bodyText || '').slice(0, 200);
  }
  const table = {
    400: '请求参数有误',
    401: 'API Key 无效或已失效',
    402: '账户余额不足',
    403: '该 Key 没有访问权限',
    404: '接口地址不存在，请检查 API 地址',
    422: '请求内容不被接受',
    429: '请求过于频繁，请稍后再试',
    500: 'DeepSeek 服务端错误',
    502: 'DeepSeek 网关错误',
    503: 'DeepSeek 服务暂时不可用',
    504: 'DeepSeek 服务响应超时',
  };
  const base = table[status] || `请求失败（HTTP ${status}）`;
  return detail ? `${base}：${detail}` : base;
}

async function readError(res) {
  let text = '';
  try { text = await res.text(); } catch { /* 忽略 */ }
  return new ApiError(describeHttpError(res.status, text), { status: res.status });
}

function networkError(err) {
  if (err && err.name === 'AbortError') return err;
  return new ApiError(
    '网络请求失败：请检查手机网络，或确认 API 地址可访问（跨域被拦截时也会表现为失败）。',
    { code: 'network', cause: err },
  );
}

/* ── 模型列表 ─────────────────────────────────────────── */

export async function listModels({ apiKey, baseUrl }, signal) {
  const url = `${normalizeBaseUrl(baseUrl)}/models`;
  let res;
  try {
    res = await fetch(url, { headers: authHeaders(apiKey), signal });
  } catch (err) { throw networkError(err); }
  if (!res.ok) throw await readError(res);
  const data = await res.json().catch(() => null);
  const ids = Array.isArray(data?.data) ? data.data.map((m) => m.id).filter(Boolean) : [];
  return ids.sort();
}

/* ── 账户余额 ─────────────────────────────────────────── */

export async function getBalance({ apiKey, baseUrl }, signal) {
  const url = `${normalizeBaseUrl(baseUrl)}/user/balance`;
  let res;
  try {
    res = await fetch(url, { headers: authHeaders(apiKey), signal });
  } catch (err) { throw networkError(err); }
  if (!res.ok) throw await readError(res);
  const data = await res.json().catch(() => ({}));
  const infos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
  return {
    isAvailable: Boolean(data.is_available),
    infos: infos.map((b) => ({
      currency: b.currency || 'CNY',
      total: b.total_balance ?? '0',
      granted: b.granted_balance ?? '0',
      toppedUp: b.topped_up_balance ?? '0',
    })),
  };
}

/* ── 单次补全（非流式）───────────────────────────────── */

/**
 * 发一次非流式请求，返回完整文本。
 *
 * 用途：朗读前的口语化改写。这类任务不需要流式（用户不会盯着看），
 * 而且需要拿到完整结果才能判断是否可用，因此用非流式更合适。
 *
 * @returns {Promise<string>} 模型返回的正文
 */
export async function completeOnce({
  apiKey, baseUrl, model, messages, temperature = 0.3, maxTokens = 1200,
}, signal) {
  const url = `${normalizeBaseUrl(baseUrl)}/chat/completions`;
  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    throw networkError(err);
  }
  if (!res.ok) throw await readError(res);

  const data = await res.json().catch(() => ({}));
  const choice = Array.isArray(data.choices) ? data.choices[0] : null;
  const content = choice?.message?.content;
  return typeof content === 'string' ? content : '';
}

/* ── 流式对话 ─────────────────────────────────────────── */

/**
 * @param {object} params
 * @param {(text:string)=>void} [handlers.onReasoning]
 * @param {(text:string)=>void} [handlers.onContent]
 * @param {(usage:object)=>void} [handlers.onUsage]
 * @param {AbortSignal} [signal]
 */
export async function streamChat(params, handlers = {}, signal) {
  const {
    apiKey, baseUrl, model, messages,
    temperature = 1, maxTokens = 4096, includeUsage = true,
    tools = null, toolChoice = null,
  } = params;

  const url = `${normalizeBaseUrl(baseUrl)}/chat/completions`;
  const baseBody = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: true,
  };
  // 只在确实有工具时才带上这两个字段 ——
  // 部分 OpenAI 兼容端点不认识 tools，空数组也可能触发 400
  if (tools && tools.length) {
    baseBody.tools = tools;
    if (toolChoice) baseBody.tool_choice = toolChoice;
  }

  async function attempt(withUsage) {
    const body = withUsage ? { ...baseBody, stream_options: { include_usage: true } } : baseBody;
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: authHeaders(apiKey),
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) { throw networkError(err); }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // 某些兼容端点不认识 stream_options，去掉后重试一次即可，不该让用户看到报错
      if (withUsage && res.status === 400 && /stream_options|include_usage/i.test(text)) {
        return { retryWithoutUsage: true };
      }
      throw new ApiError(describeHttpError(res.status, text), { status: res.status });
    }
    const collected = await consumeSse(res, handlers);
    return { retryWithoutUsage: false, collected };
  }

  const first = await attempt(includeUsage);
  if (first.retryWithoutUsage) {
    const second = await attempt(false);
    return second.collected || { content: '', toolCalls: [] };
  }
  return first.collected || { content: '', toolCalls: [] };
}

async function consumeSse(res, handlers) {
  // 累积本轮的内容与工具调用，返回给调用方
  const collected = { content: '', toolCalls: [] };
  const sink = makeCollector(collected, handlers);

  if (!res.body || !res.body.getReader) {
    // 极老浏览器：退化为一次性读取
    const text = await res.text();
    parseSseText(text, sink);
    return collected;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (err) {
      if (err && err.name === 'AbortError') return collected;
      throw networkError(err);
    }
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });

    // SSE 事件以空行分隔；这里按行处理，容错 \r\n
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      handleSseLine(line, sink);
    }
  }
  if (buffer.trim()) handleSseLine(buffer.replace(/\r$/, ''), sink);
  return collected;
}

/**
 * 生成一个收集器：把 SSE 增量写进 collected，同时转发给外部 handlers。
 *
 * 为什么需要它：
 *   工具调用必须拿到**完整的** tool_calls 才能执行，
 *   而流式响应里参数是分片到达的（同一 index 的多段 arguments 需要拼接）。
 *   调用方（对话主流程）则需要拿完整结果继续下一轮，
 *   因此这里既累积、也转发。
 */
function makeCollector(collected, handlers) {
  return {
    onUsage: handlers.onUsage,
    onReasoning: handlers.onReasoning,
    onContent(text) {
      collected.content += text;
      if (typeof handlers.onContent === 'function') handlers.onContent(text);
    },
    onToolCallDelta(delta) {
      // 按 index 归并：同一个工具调用的 name/arguments 可能分多片到达
      const i = delta.index ?? 0;
      if (!collected.toolCalls[i]) {
        collected.toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
      }
      const slot = collected.toolCalls[i];
      if (delta.id) slot.id = delta.id;
      if (delta.type) slot.type = delta.type;
      if (delta.function?.name) slot.function.name += delta.function.name;
      if (delta.function?.arguments) slot.function.arguments += delta.function.arguments;
      if (typeof handlers.onToolCall === 'function') handlers.onToolCall(delta);
    },
  };
}

function parseSseText(text, sink) {
  text.split('\n').forEach((line) => handleSseLine(line.replace(/\r$/, ''), sink));
}

function handleSseLine(line, handlers) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':')) return;
  if (!trimmed.startsWith('data:')) return;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === '[DONE]') return;

  let json;
  try { json = JSON.parse(payload); } catch { return; }

  if (json.usage && typeof handlers.onUsage === 'function') handlers.onUsage(json.usage);

  const choices = Array.isArray(json.choices) ? json.choices : [];
  for (const choice of choices) {
    const delta = choice?.delta || {};
    if (delta.reasoning_content && typeof handlers.onReasoning === 'function') {
      handlers.onReasoning(delta.reasoning_content);
    }
    if (typeof delta.content === 'string' && delta.content && typeof handlers.onContent === 'function') {
      handlers.onContent(delta.content);
    }
    // 工具调用：可能一次给多个（并行调用），逐个转发
    if (Array.isArray(delta.tool_calls) && typeof handlers.onToolCallDelta === 'function') {
      for (const tc of delta.tool_calls) handlers.onToolCallDelta(tc);
    }
  }
}

/**
 * 把收集到的工具调用规整成可执行的形式。
 * 参数是 JSON 字符串，解析失败时给出明确标记而不是抛错。
 */
export function normalizeToolCalls(collected) {
  const list = Array.isArray(collected?.toolCalls) ? collected.toolCalls : [];
  return list.filter(Boolean).map((tc, i) => {
    let args = {};
    let parseError = '';
    const rawArgs = tc.function?.arguments || '';
    if (rawArgs.trim()) {
      try {
        args = JSON.parse(rawArgs);
      } catch {
        parseError = '参数不是合法 JSON';
      }
    }
    return {
      id: tc.id || `call_${i}`,
      name: tc.function?.name || '',
      args,
      parseError,
    };
  });
}

/* ── 组装请求消息 ─────────────────────────────────────── */

/**
 * 把本地消息记录转成 API 需要的 messages 数组。
 * - 只保留 user / assistant
 * - 跳过空内容与报错消息
 * - 限制历史长度，避免超出上下文
 */
export function buildRequestMessages(systemPrompt, history, { maxTurns = 40 } = {}) {
  const usable = history
    .filter((m) => (m.role === 'user' || m.role === 'assistant'))
    .filter((m) => !m.error)
    .filter((m) => typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content }));

  // 从最近往前保留 maxTurns 条，且保证以 user 开头（否则部分端点会报错）
  let trimmed = usable.slice(-maxTurns);
  while (trimmed.length && trimmed[0].role !== 'user') trimmed = trimmed.slice(1);

  const out = [];
  if (systemPrompt) out.push({ role: 'system', content: systemPrompt });
  return out.concat(trimmed);
}
