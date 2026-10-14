/**
 * speech-text.js —— 朗读前把内容改写成适合听的文本
 *
 * 目标：屏幕上是 Markdown（标题、列表、代码块、表格、链接），
 * 直接念出来会很糟 —— 会念出 `#`、`**`、`|---|`，代码会逐字符念，
 * 链接会念一长串 URL。这里把内容改写成口语，**只用于朗读**。
 *
 * ⚠️ 关键约束：**绝不修改原消息**。
 * 改写结果只传给 TTS，界面上显示的、存进数据库的、发给模型的，
 * 始终是原文。否则会污染对话历史与后续上下文。
 *
 * 两级策略：
 *   1. cleanForSpeech()  —— 本地机械清洗，零延迟零成本，永远可用
 *   2. rewriteForSpeech() —— 调 deepseek-flash 进一步口语化（可关闭）
 *
 * 本地清洗是**保底**：即使 API 失败、没配 Key、或用户关掉了改写，
 * 也不该把原始的 Markdown 直接念出来。
 */

/** 单次改写的最大输入长度：太长既慢又贵，超长内容截断后仍能朗读 */
const MAX_INPUT = 4000;

/* ── 一、本地清洗 ─────────────────────────────────────── */

/**
 * 把 Markdown 转成"念出来不难听"的纯文本。
 *
 * 处理顺序有讲究：先摘掉整体结构（代码块、表格），
 * 再处理行内标记，最后收拾标点与空白。
 */
export function cleanForSpeech(markdown) {
  let text = String(markdown || '');
  if (!text.trim()) return '';

  // 1. 围栏代码块 → 用一句说明代替。
  //    代码逐字符念毫无意义，而且通常很长。
  text = text.replace(/```[\s\S]*?```/g, (block) => {
    const body = block.replace(/^```[^\n]*\n?/, '').replace(/```$/, '');
    const lines = body.trim().split('\n').length;
    return `（这里有一段代码，共 ${lines} 行）`;
  });

  // 2. 行内代码 → 直接保留内容（通常是变量名、命令）
  text = text.replace(/`([^`]+)`/g, '$1');

  // 3. 表格 → 逐行转成"列名：值"的叙述，直接念竖线会很难听
  text = text.replace(/(^\|.*\|\s*$\n?)+/gm, (table) => {
    const rows = table.trim().split('\n')
      .map((r) => r.trim())
      .filter((r) => r.startsWith('|'))
      .map((r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
    if (rows.length < 2) return '';
    const header = rows[0];
    // 第二行通常是 |---|---| 分隔线，跳过
    const body = rows.slice(1).filter((r) => !r.every((c) => /^:?-{2,}:?$/.test(c)));
    const parts = body.slice(0, 8).map((r) => {
      const pairs = r.map((cell, i) => {
        const key = header[i] || '';
        return key ? `${key}是${cell}` : cell;
      });
      return pairs.join('，');
    });
    return `（表格内容：${parts.join('；')}）`;
  });

  // 4. 图片 → 说明有图；链接 → 只留文字，去掉 URL
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, (m, alt) => (alt ? `（图片：${alt}）` : '（此处有图片）'));
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // 裸链接
  text = text.replace(/https?:\/\/\S+/g, '（链接）');

  // 5. 标题标记：去掉 #，但保留文字（必要时补一个停顿）
  text = text.replace(/^#{1,6}\s*(.+)$/gm, '$1。');

  // 6. 强调与删除线
  text = text.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1');
  text = text.replace(/___([^_]+)___/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/~~([^~]+)~~/g, '$1');

  // 7. 分隔线 → 停顿
  text = text.replace(/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/gm, '。');

  // 8. 引用标记与列表符号
  text = text.replace(/^\s*>\s?/gm, '');
  text = text.replace(/^\s*[-*+]\s+/gm, '');
  text = text.replace(/^\s*\d+\.\s+/gm, '');

  // 9. 多余标点与空白
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{2,}/g, '。');
  text = text.replace(/\n/g, '，');
  // 代码块/表格替换出来的说明是括号包裹的，前面若已有标点，
  // 会出现"即可：。（这里有一段代码…"这种读起来断裂的停顿。
  // 这里把「标点 + 换行 + 括号」整理成「标点 + 括号」。
  text = text.replace(/([。，；：！？])\s*[。，]?\s*(（)/g, '$1$2');
  // 连续标点只保留一个
  text = text.replace(/([。，；：])\s*([。，；：])/g, '$1');
  text = text.replace(/[。，]{2,}/g, '。');
  text = text.replace(/\s+([。，！？；：）])/g, '$1');
  text = text.replace(/^[。，\s]+/, '');

  return text.trim();
}

/* ── 二、调用 API 口语化改写 ─────────────────────────── */

/** 总结用的提示词。要点：极短、只讲结论、不加评论。 */
const REWRITE_SYSTEM = `你是一个语音播报稿总结助手。把用户给你的文本压缩成**极短的口头摘要**。

硬性要求：
1. **只输出 1 到 3 句话**。这是最重要的要求 —— 宁可少说，不要多说。
   内容多的时候，只保留最核心的结论，细节全部舍弃。
2. 只讲结论与关键动作，**不要**列举、铺垫、举例、解释原因。
3. 不要任何开场白与结束语（如"好的"、"总结一下"、"希望有帮助"）。
4. 不要 Markdown 标记、代码、链接、表格。
5. 用适合念出来的短句，书面语可以，不必刻意口语化。
6. 保持原意，不要添加原文没有的信息，也不要发表评价。

示例：
输入：一份 800 字的部署文档，讲了三步安装、两种配置方式、五个常见问题。
输出：部署分三步：装依赖、改配置、启动服务。常见问题里最容易踩的是端口占用。

输入：一段解释闭包的代码说明，含示例代码与三条注意事项。
输出：闭包就是函数记住了定义时的外部变量，可以在这个变量生命周期之外继续访问它。`;

/**
 * 调 API 把文本总结成极短的口头摘要。
 *
 * @returns {Promise<{ok:boolean, text:string, error?:string}>}
 *   ok=false 时 text 为空，调用方应回退到本地清洗结果。
 */
export async function rewriteForSpeech(text, settings, deps = {}) {
  const { completeOnce } = deps;
  const source = String(text || '').trim();
  if (!source) return { ok: false, text: '', error: '内容为空' };
  if (typeof completeOnce !== 'function') {
    return { ok: false, text: '', error: '缺少补全接口' };
  }
  if (!settings.apiKey) {
    return { ok: false, text: '', error: '未配置 API Key' };
  }

  // 短内容不值得总结：一句"好的，我这就去做"总结完反而更奇怪。
  // 阈值按字符数粗略判断，中文大致对应字数。
  const minChars = Number(settings.speechSummarizeMin) || 120;
  if (source.length < minChars) {
    return { ok: false, text: '', error: `内容较短（${source.length} 字），跳过总结` };
  }

  // 超长内容截断：总结本来就是为了简短，不需要喂完整篇。
  const input = source.length > MAX_INPUT
    ? `${source.slice(0, MAX_INPUT)}…（后续内容略）`
    : source;

  try {
    const out = await completeOnce({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      // 总结是简单任务，固定用便宜快速的 flash，不跟随对话模型 ——
      // 用 v4-pro 做这件事性价比很低。
      model: settings.speechModel || 'deepseek-flash',
      messages: [
        { role: 'system', content: REWRITE_SYSTEM },
        { role: 'user', content: input },
      ],
      temperature: 0.2,
      maxTokens: 300,
    }, deps.signal);

    let cleaned = String(out || '').trim();
    if (!cleaned) return { ok: false, text: '', error: '总结结果为空' };

    // 兜底：模型偶尔不听话，返回一大段。这里硬性截断到 3 句，
    // 确保"朗读时只听到一两句"这个体验是可靠的。
    cleaned = clampSentences(cleaned, 3);
    return { ok: true, text: cleaned };
  } catch (err) {
    return { ok: false, text: '', error: err?.message || String(err) };
  }
}

/**
 * 把文本限制在最多 N 句。
 *
 * 为什么需要：提示词只能"请求"模型简短，不能保证。
 * 朗读场景下必须硬性保证长度，否则一条长回复会被念很久。
 *
 * 处理三种情况：
 *   1. 中英文句末标点正常切分
 *   2. 英文句点：需排除 "3.14"、"Node.js"、"v1.2" 这类非句末的点
 *   3. 完全没有标点的长文本：按字数硬截断，否则限制形同虚设
 */
export function clampSentences(text, maxSentences = 3) {
  const s = String(text || '').trim();
  if (!s) return '';

  /*
    句末标点的判定：

    中文标点（。！？；）直接切。

    英文句点要区分两种情况：
      - "Node.js v1.2.3"、"3.14" 里的点是词内点，不是句末
      - "First one. Second one." 里的点确实是句末

    区分依据：**句末点的后面必然是空白或结尾**，而且下一句通常以
    大写字母开头。词内点后面紧跟字母或数字，不会跟空格。
    因此规则是：点 + (空格后接大写字母 | 结尾)。
    这样 "v1.2.3 已发布" 不会被误切（点后是数字），
    "one. Second" 会被正确切分。
  */
  const splitter = /(?<=[。！？；!?;])|(?<=\.)(?=\s+[A-Z“"'(]|\s*$)/;
  const parts = s.split(splitter).map((p) => p.trim()).filter(Boolean);

  if (parts.length > maxSentences) {
    // 重新拼接时按语言决定是否补空格：
    //   以英文句点结尾 → 补一个空格（英文句后需要空格）
    //   以中文标点结尾 → 不加（中文里加空格会打乱朗读节奏）
    const kept = parts.slice(0, maxSentences);
    let out = '';
    for (const p of kept) {
      out += p;
      if (/\.$/.test(p)) out += ' ';
    }
    return out.trim();
  }

  // 没有标点可切（例如模型输出了连续长句）：按字数硬截断。
  // 单句超过 90 字时截到 90 字，保证不会被念很久。
  if (parts.length === 1 && parts[0].length > 90) {
    return parts[0].slice(0, 90) + '…';
  }

  return s;
}

/* ── 三、统一入口 ─────────────────────────────────────── */

/**
 * 准备朗读文本。
 *
 * 流程：
 *   1. 本地清洗（去 Markdown，永远执行）
 *   2. 若开启总结且配置齐全，调 API 压缩成 1–3 句
 *
 * 关于失败时的回退策略（重要）：
 *   长内容总结失败时，**不再回退到念全文** —— 那会把一段 800 字的回复
 *   完整念出来，正是要避免的。此时改为念一句提示，让用户知道内容较长、
 *   建议看屏幕。
 *   短内容本来就该完整念，不受影响。
 *
 * 任何情况都不抛错：朗读是主流程，不能因为总结失败就哑掉。
 *
 * @returns {Promise<{text:string, usedApi:boolean, note:string}>}
 */
export async function prepareSpeechText(raw, settings, deps = {}) {
  const local = cleanForSpeech(raw);
  const base = local || String(raw || '').trim();

  if (settings.speechSimplify === false) {
    return { text: base, usedApi: false, note: '' };
  }

  // 本地清洗后仍然较短：直接念，没必要总结
  const minChars = Number(settings.speechSummarizeMin) || 120;
  if (base.length < minChars) {
    return { text: base, usedApi: false, note: '' };
  }

  const result = await rewriteForSpeech(base, settings, deps);
  if (result.ok) {
    return { text: result.text, usedApi: true, note: '' };
  }

  // 总结失败，且内容确实很长：给一句提示，而不是把长文念完
  const fallback = '这段回复比较长，我在这里简单说明：内容已显示在屏幕上，建议直接查看。';
  return {
    text: fallback,
    usedApi: false,
    note: result.error || '总结失败',
  };
}
