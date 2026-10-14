/**
 * search.js —— 联网搜索
 *
 * 为什么需要：手机版早期没有工具面，涉及实时信息（新闻、价格、天气、
 * 最新版本）时 Fairy 只能说自己查不到。加上搜索后她可以查证再回答。
 *
 * 设计取舍：
 *   1. **免密钥**。Bing 等搜索引擎的公开结果页可直接抓取，
 *      不需要申请 API Key —— 降低使用门槛是首要目标。
 *   2. **在原生层发请求**。搜索站点不返回 CORS 头，WebView 里 fetch 会被拦。
 *      同时原生层能设置完整的请求头（部分站点会校验 UA / Accept-Language）。
 *   3. **HTML 解析放在原生层**。抓回来的是网页，需要提取结构化结果；
 *      用 HTML 解析比在 JS 里写正则更稳，也避免把大段 HTML 传进 WebView。
 *   4. **失败只降级，不阻塞**。搜索是增强能力，网络问题不该让对话发不出去。
 */

/**
 * 可选搜索源。均免密钥。
 *
 * 取舍依据是**实测**（见 tools/verify-search.mjs）：
 * Bing / 搜狗 / 360 都能稳定取到结果；
 * Mojeek 对脚本请求返回 403，DuckDuckGo 与多数 SearXNG 实例在当前网络下不可达，
 * 因此都不列入 —— 宁可少给选项，也不要让用户点了失败。
 */
export const SEARCH_ENGINES = {
  bing: {
    id: 'bing',
    label: 'Bing（推荐，中文结果好）',
    buildUrl: (q) => `https://cn.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-CN`,
  },
  so360: {
    id: 'so360',
    label: '360 搜索（结果较多）',
    buildUrl: (q) => `https://www.so.com/s?q=${encodeURIComponent(q)}`,
  },
  sogou: {
    id: 'sogou',
    label: '搜狗（补漏用）',
    buildUrl: (q) => `https://www.sogou.com/web?query=${encodeURIComponent(q)}`,
  },
};

export function getEngine(id) {
  return SEARCH_ENGINES[id] || SEARCH_ENGINES.bing;
}

/**
 * 判断这条消息是否值得联网。
 *
 * 目的是省流量与延迟：日常闲聊、写作、代码问题不需要搜。
 * 宁可漏搜（模型可以据此说明不确定）也不要滥搜（每句都联网很慢）。
 */
const FRESH_PATTERNS = [
  /最新|现在|目前|今天|昨天|明天|今年|当前|实时|刚刚|近期|最近|这几天/,
  /是什么|是谁|多少钱|价格|股价|汇率|天气|气温|几点|在哪|哪里|怎么样/,
  /新闻|消息|进展|发布|上线|更新|版本|发布会|报道|出了|推出了/,
  /搜一下|搜搜|查一下|查查|搜索|百度|谷歌|帮我查|帮我搜|网上/,
  /比分|赛程|排名|票房|销量|榜单|评选/,
];

export function shouldSearch(text) {
  const s = String(text || '').trim();
  if (s.length < 4) return false;
  return FRESH_PATTERNS.some((re) => re.test(s));
}

/**
 * 从用户消息里抽出查询词。
 * 去掉口语化的前缀，避免把「帮我查一下」整句丢给搜索引擎。
 */
export function buildQuery(text) {
  let q = String(text || '').trim();
  q = q.replace(
    /^(帮我|请|麻烦|能不能|可以|能不能帮我|可以帮我)?\s*(搜一下|搜搜|查一下|查查|搜索一下|搜索|百度一下|百度|谷歌一下|谷歌)\s*/u,
    '',
  );
  q = q.replace(/[?？。！!]+$/u, '').trim();
  return q || String(text || '').trim();
}

/**
 * 执行搜索。
 *
 * 请求与解析都在原生层完成（见 SearchClient.java），
 * 这里只负责参数与结果格式转换。
 *
 * @returns {Promise<{ok:boolean, results:Array, error?:string, engine?:string}>}
 */
export function search(query, { engine = 'bing', count = 5 } = {}) {
  const q = String(query || '').trim();
  if (!q) return Promise.resolve({ ok: false, results: [], error: '搜索词为空' });

  const bridge = typeof window !== 'undefined' ? window.AndroidBridge : null;
  if (!bridge || typeof bridge.searchWeb !== 'function') {
    return Promise.resolve({
      ok: false, results: [], error: '当前环境不支持联网搜索（需在 APK 内使用）',
    });
  }

  const eng = getEngine(engine);
  const params = {
    engine: eng.id,
    url: eng.buildUrl(q),
    query: q,
    count: Math.max(1, Math.min(10, Number(count) || 5)),
  };

  return new Promise((resolve) => {
    let settled = false;
    const done = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };

    if (typeof window !== 'undefined') {
      window.__fairySearch = window.__fairySearch || {};
      window.__fairySearch.onResult = (ok, payload) => {
        if (!ok) {
          done({ ok: false, results: [], error: String(payload || '搜索失败'), engine: params.engine });
          return;
        }
        try {
          const parsed = JSON.parse(payload || '{}');
          const results = Array.isArray(parsed.results) ? parsed.results : [];
          done({
            ok: results.length > 0,
            results,
            engine: params.engine,
            error: results.length ? undefined : '没有找到相关结果',
          });
        } catch (err) {
          done({ ok: false, results: [], error: `结果解析失败：${err.message}`, engine: params.engine });
        }
      };
    }

    try {
      bridge.searchWeb(JSON.stringify(params));
    } catch (err) {
      done({ ok: false, results: [], error: `调用搜索失败：${err.message}`, engine: params.engine });
    }

    // 超时保护：搜索慢不该让对话一直等
    setTimeout(() => done({ ok: false, results: [], error: '搜索超时', engine: params.engine }), 20000);
  });
}

/**
 * 把搜索结果整理成可插入对话的上下文。
 *
 * 用明确的标记包起来，让模型知道这是外部资料而非用户发言；
 * 并要求它标注来源、搜不到时直说 —— 避免把搜索片段当自己的记忆来编。
 */
export function formatForPrompt(query, results) {
  if (!results || !results.length) return '';
  const lines = results.map((r, i) => {
    const parts = [`[${i + 1}] ${r.title || '(无标题)'}`];
    if (r.url) parts.push(`来源：${r.url}`);
    if (r.snippet) parts.push(r.snippet);
    return parts.join('\n');
  });
  return [
    '【联网搜索结果】',
    `查询词：${query}`,
    `检索时间：${new Date().toLocaleString('zh-CN')}`,
    '',
    ...lines,
    '',
    '以上是通过搜索引擎实时检索到的公开资料，请据此回答用户的问题。',
    '要求：',
    '1. 在引用具体事实时标注来源编号，如 [1]。',
    '2. 搜索结果可能与问题无关或互相矛盾，请自行判断，不要照搬。',
    '3. 如果这些结果不足以回答问题，直接说明查到的信息有限，不要编造。',
  ].join('\n');
}

/**
 * 把搜索上下文作为一条 system 消息插入对话。
 *
 * 为什么不直接拼进用户消息：那样会污染用户原话，
 * 后续重新生成或编辑消息时会带上搜索结果，语义混乱。
 */
export function injectSearchContext(messages, searchContext) {
  if (!searchContext) return messages;
  const out = Array.isArray(messages) ? [...messages] : [];
  // 插到最后一条 user 消息之前，让模型先读到资料再看到问题
  let insertAt = out.length;
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i] && out[i].role === 'user') { insertAt = i; break; }
  }
  out.splice(insertAt, 0, { role: 'system', content: searchContext });
  return out;
}
