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

/** 改写用的提示词。要点：只改写、不加内容、保持简洁。 */
const REWRITE_SYSTEM = `你是一个语音朗读稿改写助手。把用户给你的文本改写成**适合朗读**的口语稿。

要求：
1. 只做改写，**不要增加原文没有的信息**，也不要发表评论或总结。
2. 去掉所有 Markdown 痕迹（如 #、**、\`、|、链接地址）。
3. 长句拆成短句；书面语换成口语；数字与英文缩写按中文习惯读法写。
4. 代码或公式用一句自然的话描述它在做什么，不要逐字符照抄。
5. 保持原意与语气，不要抒情、不要加开场白或结束语。
6. 直接输出改写后的正文，不要任何前后缀、不要解释你在做什么。

如果原文已经适合朗读，原样返回即可。`;

/**
 * 调 API 把文本改写成更适合朗读的口语稿。
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

  // 超长内容截断：改写是"为了好听"，不是"必须完整"，
  // 为一段几千字的内容花掉大量 token 并不划算。
  const input = source.length > MAX_INPUT
    ? `${source.slice(0, MAX_INPUT)}…（后续内容略）`
    : source;

  try {
    const out = await completeOnce({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      // 改写是简单任务，固定用便宜快速的 flash，不跟随对话模型 ——
      // 用 v4-pro 做这件事性价比很低。
      model: settings.speechModel || 'deepseek-flash',
      messages: [
        { role: 'system', content: REWRITE_SYSTEM },
        { role: 'user', content: input },
      ],
      temperature: 0.3,
      maxTokens: 1500,
    }, deps.signal);

    const cleaned = String(out || '').trim();
    if (!cleaned) return { ok: false, text: '', error: '改写结果为空' };
    return { ok: true, text: cleaned };
  } catch (err) {
    return { ok: false, text: '', error: err?.message || String(err) };
  }
}

/* ── 三、统一入口 ─────────────────────────────────────── */

/**
 * 准备朗读文本。
 *
 * 流程：
 *   1. 本地清洗（永远执行，作为保底）
 *   2. 若开启 API 改写且配置齐全，再调 API 进一步口语化
 *
 * 任何一步失败都不会抛错 —— 朗读是主流程，不能因为改写失败就哑掉。
 *
 * @returns {Promise<{text:string, usedApi:boolean, note:string}>}
 */
export async function prepareSpeechText(raw, settings, deps = {}) {
  const local = cleanForSpeech(raw);
  const base = local || String(raw || '').trim();

  if (settings.speechRewrite === false) {
    return { text: base, usedApi: false, note: '' };
  }

  const result = await rewriteForSpeech(base, settings, deps);
  if (result.ok) {
    return { text: result.text, usedApi: true, note: '' };
  }
  // 改写失败不是错误：本地清洗的结果同样能念，只是不够口语化
  return { text: base, usedApi: false, note: result.error || '' };
}
