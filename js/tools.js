/**
 * tools.js —— Fairy 的工具箱
 *
 * 这里定义 Fairy 能**真正调用**的能力，而不是靠提示词假装。
 *
 * 设计原则：
 *   1. 能力必须有真实实现。做不到的事就不要注册成工具 ——
 *      注册了模型会调用，调用后返回假数据，比直接说"做不到"更糟。
 *   2. 每个工具的权限边界写在它自己旁边，便于审查。
 *   3. 一切失败都返回结构化结果（ok:false + 原因），不抛异常 ——
 *      工具失败应该是模型能看到的信息，而不是中断整轮对话。
 *
 * 工具与宿主（Android 原生层）的分工：
 *   JS 侧负责定义、参数校验、结果整形；
 *   真正碰系统资源的操作（文件、设备信息）由原生层执行，
 *   经 window.AndroidBridge 返回。这样能做权限检查与路径限制。
 */

/* ── 工具定义（OpenAI function calling 格式）────────────── */

/**
 * 文件工具的路径限制说明（会写进工具描述，让模型知道边界）。
 * 只允许 App 自己的目录，模型不该尝试访问其他位置。
 */
export const FILE_SCOPE_NOTE =
  '只能访问应用自己的文件目录（Fairy 的文档区），不能访问手机上的其他位置。';

/** 工具箱定义。传给 API 的 tools 字段。 */
export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'device_info',
      description:
        '获取本机当前的真实状态：电量、充电状态、网络类型、可用存储空间、'
        + '系统版本、屏幕尺寸、当前时间。当你需要回答与设备实际情况相关的问题时使用。'
        + '返回的都是实测值，不要自己编造这些数据。',
      parameters: {
        type: 'object',
        properties: {
          fields: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['battery', 'network', 'storage', 'system', 'time'],
            },
            description: '想查询的项。省略则返回全部。',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: `列出 Fairy 文档区里的文件。${FILE_SCOPE_NOTE}`,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '相对路径，省略或填 "/" 表示根目录。',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: `读取 Fairy 文档区里某个文件的文本内容。${FILE_SCOPE_NOTE}`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对路径，例如 notes/todo.md' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        `把文本写入 Fairy 文档区的文件（不存在则创建，存在则覆盖）。${FILE_SCOPE_NOTE}`
        + '适合存放笔记、整理的资料、需要留存的结论。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对路径，例如 notes/todo.md' },
          content: { type: 'string', description: '要写入的完整文本内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: `删除 Fairy 文档区里的一个文件。${FILE_SCOPE_NOTE}`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对路径' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description:
        '把一条值得长期记住的信息写入长期记忆，之后的对话会自动带上它。'
        + '适合记录主人的偏好、习惯、长期有效的事实。'
        + '不要记录一次性的、临时的内容。',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: '要记住的内容，用一句话写清楚，例如「主人偏好简洁的回答」。',
          },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall',
      description: '检索长期记忆里已保存的内容。当你不确定之前是否记过某件事时使用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词，省略则返回全部记忆' },
        },
        required: [],
      },
    },
  },
];

/* ── 路径安全 ─────────────────────────────────────────── */

/**
 * 校验并规整相对路径。
 *
 * 这一层是**安全边界**，不能只依赖原生侧检查：
 * 路径拼接、`..` 逃逸这类问题在两侧各查一遍才稳妥。
 *
 * @returns {{ok:true, path:string} | {ok:false, error:string}}
 */
export function sanitizePath(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: true, path: '' };

  // 拒绝绝对路径与盘符
  if (/^([a-zA-Z]:|[\\/])/.test(raw)) {
    return { ok: false, error: '只接受相对路径，不能以 / 或盘符开头' };
  }
  // 归一化分隔符后逐段检查
  const parts = raw.replace(/\\/g, '/').split('/');
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!out.length) return { ok: false, error: '路径越界：不能离开文档区' };
      out.pop();
      continue;
    }
    // 排除控制字符与 Windows 保留字符
    if (/[\0<>:"|?*]/.test(part)) {
      return { ok: false, error: `文件名含非法字符：${part}` };
    }
    out.push(part);
  }
  return { ok: true, path: out.join('/') };
}

/* ── 工具执行 ─────────────────────────────────────────── */

/** 把原生返回的 JSON 字符串安全解析成对象 */
function parseBridgeResult(raw) {
  if (raw === null || raw === undefined) {
    return { ok: false, error: '原生层没有返回结果（可能不支持该功能）' };
  }
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    if (parsed && typeof parsed === 'object') return parsed;
    return { ok: false, error: '原生层返回了非预期的结果' };
  } catch {
    // 原生层可能直接返回一段文本
    const text = String(raw);
    return text.trim() ? { ok: true, text } : { ok: false, error: '空结果' };
  }
}

/**
 * 创建工具执行器。
 *
 * @param {object} deps
 * @param {() => object} deps.getSettings  读取设置（延迟取，避免持有旧值）
 * @param {object} [deps.memory]           长期记忆控制器
 * @returns {{run:(name:string, args:object)=>Promise<object>, hasNative:()=>boolean}}
 */
export function createToolRunner(deps = {}) {
  const { getSettings, memory } = deps;

  /** 取原生桥；不存在时返回 null（浏览器环境） */
  function bridge() {
    const b = typeof window !== 'undefined' ? window.AndroidBridge : null;
    return b && typeof b === 'object' ? b : null;
  }

  function hasNative() {
    // 尊重设置开关：关掉工具后，runWithTools 不会注册任何工具，
    // 模型也就无从调用 —— 这比"注册了但执行时拒绝"更干净，
    // 不会浪费一轮请求去告诉模型"不允许"。
    try {
      if (typeof getSettings === 'function' && getSettings()?.toolsEnabled === false) {
        return false;
      }
    } catch { /* 读设置失败时按允许处理 */ }
    const b = bridge();
    return Boolean(b && typeof b.callTool === 'function');
  }

  /**
   * 调原生层执行工具。
   * 原生层统一入口 callTool(name, argsJson) → 返回 JSON 字符串。
   */
  async function callNative(name, args) {
    const b = bridge();
    if (!b || typeof b.callTool !== 'function') {
      return { ok: false, error: '当前环境不支持该工具（需要 Android 版）' };
    }
    try {
      const raw = b.callTool(name, JSON.stringify(args || {}));
      return parseBridgeResult(raw);
    } catch (err) {
      return { ok: false, error: `调用失败：${err?.message || err}` };
    }
  }

  /** 各工具的实现 */
  const handlers = {
    async device_info(args) {
      const fields = Array.isArray(args?.fields) ? args.fields : [];
      return callNative('device_info', { fields });
    },

    async list_files(args) {
      const p = sanitizePath(args?.path);
      if (!p.ok) return p;
      return callNative('list_files', { path: p.path });
    },

    async read_file(args) {
      const p = sanitizePath(args?.path);
      if (!p.ok) return p;
      if (!p.path) return { ok: false, error: '必须指定文件路径' };
      return callNative('read_file', { path: p.path });
    },

    async write_file(args) {
      const p = sanitizePath(args?.path);
      if (!p.ok) return p;
      if (!p.path) return { ok: false, error: '必须指定文件路径' };
      const content = String(args?.content ?? '');
      // 限制单次写入大小：避免模型一次写入巨量内容把存储占满
      const MAX_WRITE = 200 * 1024;
      if (content.length > MAX_WRITE) {
        return { ok: false, error: `内容过长（${content.length} 字符），单次上限 ${MAX_WRITE}` };
      }
      return callNative('write_file', { path: p.path, content });
    },

    async delete_file(args) {
      const p = sanitizePath(args?.path);
      if (!p.ok) return p;
      if (!p.path) return { ok: false, error: '必须指定文件路径' };
      return callNative('delete_file', { path: p.path });
    },

    async remember(args) {
      const content = String(args?.content ?? '').trim();
      if (!content) return { ok: false, error: '要记住的内容不能为空' };
      if (!memory || typeof memory.add !== 'function') {
        return { ok: false, error: '长期记忆未启用' };
      }
      const r = await memory.add(content);
      return r.ok
        ? { ok: true, text: `已记住：${content}` }
        : { ok: false, error: r.error || '写入记忆失败' };
    },

    async recall(args) {
      if (!memory || typeof memory.search !== 'function') {
        return { ok: false, error: '长期记忆未启用' };
      }
      const items = memory.search(String(args?.query ?? ''));
      if (!items.length) return { ok: true, text: '没有找到相关记忆。' };
      return { ok: true, text: items.map((m, i) => `${i + 1}. ${m.content}`).join('\n') };
    },
  };

  /**
   * 执行一个工具调用。
   *
   * 任何异常都在这里被转成 {ok:false, error} —— 工具失败要能被模型看到，
   * 而不是中断整轮对话。模型看到失败后往往能自行换一种做法。
   */
  async function run(name, args) {
    const fn = handlers[name];
    if (!fn) return { ok: false, error: `未知工具：${name}` };
    try {
      return await fn(args || {});
    } catch (err) {
      return { ok: false, error: `工具执行异常：${err?.message || err}` };
    }
  }

  return { run, hasNative };
}

/**
 * 把工具执行结果转成给模型看的文本。
 * 保持简洁：模型只需要知道成功与否、拿到了什么。
 */
export function formatToolResult(name, result) {
  if (result && result.ok) {
    if (typeof result.text === 'string' && result.text) return result.text;
    // 原样返回结构化数据，模型能读懂 JSON
    const { ok, ...rest } = result;
    return JSON.stringify(rest, null, 2);
  }
  const reason = result?.error || '未知错误';
  return `工具调用失败：${reason}`;
}
