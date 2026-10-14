/**
 * memory.js —— 长期记忆
 *
 * 目标：让 Fairy 记得住跨对话的内容（主人的偏好、习惯、长期事实）。
 *
 * 存储位置：**只存本机**，不经过任何服务器。
 *   文件由原生层管理（App 私有目录），JS 侧通过 AndroidBridge 读写。
 *   浏览器环境下退化为 localStorage —— 明确不是同一份数据，
 *   但至少功能可用，便于开发时验证。
 *
 * 设计取舍：
 *   1. **不做向量检索**。记忆条数通常在几十到几百条，
 *      关键词匹配足够用，引入嵌入模型不值得（体积、延迟、成本）。
 *   2. **有容量上限**。长期记忆无限增长会撑爆上下文，
 *      也会让注入的提示词越来越长、越来越贵。
 *      超过上限时淘汰"最久没被用到"的条目。
 *   3. **可查看可删除**。记忆是用户的隐私数据，
 *      界面上必须能看到全部内容并逐条删除。
 */

/** 记忆条数上限：超过后淘汰最久未使用的 */
const MAX_ITEMS = 200;
/** 生成提示词时最多注入多少条 */
const MAX_INJECT = 20;

/** 生成唯一 id（不依赖 crypto，兼容旧 WebView） */
function makeId() {
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function bridge() {
  const b = typeof window !== 'undefined' ? window.AndroidBridge : null;
  return b && typeof b === 'object' ? b : null;
}

/** 浏览器兜底：用 localStorage（与 Android 侧不是同一份数据） */
const LS_KEY = 'fairy.memory.v1';

/**
 * 创建记忆控制器。
 * @param {{read?:(k:string)=>string, write?:(k:string,v:string)=>void}} [deps]
 *   read/write 用于注入存储实现，便于测试。
 */
export function createMemory(deps = {}) {
  let items = [];
  let loaded = false;
  let lastError = '';

  /** 从存储载入 */
  function load() {
    if (loaded) return;
    loaded = true;
    try {
      const b = bridge();
      let raw = '';
      if (b && typeof b.readStore === 'function') {
        raw = b.readStore('memory') || '';
      } else if (deps.read) {
        raw = deps.read(LS_KEY) || '';
      } else if (typeof localStorage !== 'undefined') {
        raw = localStorage.getItem(LS_KEY) || '';
      }
      if (raw) {
        const data = JSON.parse(raw);
        items = Array.isArray(data?.items) ? data.items : [];
      }
    } catch (err) {
      lastError = `读取记忆失败：${err?.message || err}`;
      items = [];
    }
  }

  /** 写入存储 */
  function persist() {
    try {
      const raw = JSON.stringify({ version: 1, items });
      const b = bridge();
      if (b && typeof b.writeStore === 'function') {
        const r = b.writeStore('memory', raw);
        // 原生层返回 "1" 表示成功
        if (r !== undefined && r !== null && String(r) !== '1') {
          lastError = `原生层拒绝写入：${r}`;
          return false;
        }
        return true;
      }
      if (deps.write) {
        deps.write(LS_KEY, raw);
        return true;
      }
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(LS_KEY, raw);
        return true;
      }
      lastError = '没有可用的存储';
      return false;
    } catch (err) {
      lastError = `保存记忆失败：${err?.message || err}`;
      return false;
    }
  }

  /**
   * 添加一条记忆。
   * 内容完全相同的条目会合并（刷新时间），不重复堆积。
   */
  async function add(content) {
    load();
    const text = String(content || '').trim();
    if (!text) return { ok: false, error: '内容为空' };

    const existing = items.find((m) => m.content === text);
    if (existing) {
      existing.usedAt = Date.now();
      persist();
      return { ok: true, text: '（这条已经记过了）' };
    }

    items.push({
      id: makeId(),
      content: text,
      createdAt: Date.now(),
      usedAt: Date.now(),
    });

    // 超出上限：淘汰最久没被使用的
    if (items.length > MAX_ITEMS) {
      items.sort((a, b) => (b.usedAt || 0) - (a.usedAt || 0));
      items = items.slice(0, MAX_ITEMS);
    }

    return persist() ? { ok: true } : { ok: false, error: lastError };
  }

  /** 关键词检索；query 为空则返回全部 */
  function search(query) {
    load();
    const q = String(query || '').trim();
    if (!q) return items.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    // 按字符切词，对中文友好（不做分词器，够用即可）
    const terms = q.split(/[\s,，、]+/).filter(Boolean);
    const hit = items.filter((m) => terms.every((t) => m.content.includes(t)));
    // 命中的记忆刷新使用时间，让"常用的"留存更久
    const now = Date.now();
    for (const m of hit) m.usedAt = now;
    if (hit.length) persist();
    return hit.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  /** 列出全部（供设置界面展示） */
  function list() {
    load();
    return items.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  /** 删除一条 */
  function remove(id) {
    load();
    const before = items.length;
    items = items.filter((m) => m.id !== id);
    if (items.length === before) return false;
    persist();
    return true;
  }

  /** 清空 */
  function clear() {
    load();
    items = [];
    return persist();
  }

  function count() {
    load();
    return items.length;
  }

  /**
   * 生成注入到 system prompt 的记忆区块。
   *
   * 只取最近的若干条：注入太多既贵又会稀释当前对话的注意力。
   * 没有记忆时返回空字符串，调用方直接拼接即可。
   */
  function buildPromptBlock() {
    load();
    if (!items.length) return '';
    const recent = items
      .slice()
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, MAX_INJECT);
    const lines = recent.map((m) => `- ${m.content}`).join('\n');
    return `【长期记忆】\n以下是之前对话中记下的、长期有效的信息。`
      + `它们可能已经过时，若有冲突以主人当前的说法为准。\n${lines}`;
  }

  return {
    add, search, list, remove, clear, count, buildPromptBlock,
    getLastError: () => lastError,
    /** 供测试用：不落盘地注入数据 */
    _setItems: (arr) => { items = Array.isArray(arr) ? arr : []; loaded = true; },
  };
}
