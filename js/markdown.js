/**
 * markdown.js —— 轻量 Markdown 渲染器（安全、无依赖）
 *
 * 设计取舍：
 *  - 先整体转义 HTML，再做 markdown 变换。这样任何用户/模型内容都无法注入标签。
 *  - 代码块在转义后抽取为占位符，避免其中的 * _ [ ] 被当成语法处理。
 *  - 段落内的单换行会被保留为 <br>，聊天场景下更符合预期。
 *
 * 不追求 CommonMark 完备性，只覆盖模型实际会输出的子集。
 */

const CODE_TOKEN = '\u0000CODE';
const IC_TOKEN = '\u0001IC';
const TOKEN_END = '\u0000';

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 只允许安全协议，阻断 javascript: 之类 */
function safeUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (/^(https?:|mailto:|tel:|#|\/|\.\/|\.\.\/)/i.test(raw)) return raw;
  return '';
}

/* ── 行内元素 ─────────────────────────────────────────── */

function inline(escaped) {
  const codes = [];
  // 1. 行内代码最先占位，保护其内容
  let out = escaped.replace(/`([^`\n]+)`/g, (_m, code) => {
    codes.push(code);
    return `${IC_TOKEN}${codes.length - 1}${TOKEN_END}`;
  });

  // 2. 图片（仅保留 alt 文本，避免远程请求与隐私泄漏）
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, alt) => alt);

  // 3. 链接
  out = out.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, text, url) => {
    const href = safeUrl(url);
    if (!href) return text;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });

  // 4. 裸露的 URL
  out = out.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g, (_m, pre, url) => {
    const clean = url.replace(/[.,;:!?]+$/, '');
    const tail = url.slice(clean.length);
    return `${pre}<a href="${clean}" target="_blank" rel="noopener noreferrer">${clean}</a>${tail}`;
  });

  // 5. 粗体 / 删除线 / 斜体
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, '$1<em>$2</em>');

  // 6. 还原行内代码
  out = out.replace(new RegExp(`${IC_TOKEN}(\\d+)${TOKEN_END}`, 'g'), (_m, i) => {
    const code = codes[Number(i)];
    return code === undefined ? '' : `<code>${code}</code>`;
  });

  return out;
}

/* ── 代码块渲染 ───────────────────────────────────────── */

function renderCodeBlock(lang, code) {
  const language = String(lang || '').trim() || 'text';
  // code 已经是转义过的文本，可以安全内联
  return `<div class="code-block"><div class="code-head"><span>${escapeHtml(language)}</span>` +
    `<button class="code-copy" type="button" data-copy>复制</button></div>` +
    `<pre><code>${code.replace(/\n$/, '')}</code></pre></div>`;
}

/* ── 主渲染 ───────────────────────────────────────────── */

export function renderMarkdown(source) {
  const src = String(source ?? '').replace(/\r\n?/g, '\n');
  if (!src.trim()) return '';

  let text = escapeHtml(src);

  // 抽取围栏代码块
  const blocks = [];
  text = text.replace(/^[ \t]*```([^\n`]*)\n([\s\S]*?)^[ \t]*```[ \t]*$/gm, (_m, lang, code) => {
    blocks.push(renderCodeBlock(lang, code));
    return `${CODE_TOKEN}${blocks.length - 1}${TOKEN_END}`;
  });
  // 未闭合的代码块（流式输出中很常见）：按已到达的内容先渲染
  text = text.replace(/^[ \t]*```([^\n`]*)\n([\s\S]*)$/m, (_m, lang, code) => {
    if (!code.trim()) return '';
    blocks.push(renderCodeBlock(lang, code));
    return `${CODE_TOKEN}${blocks.length - 1}${TOKEN_END}`;
  });

  const lines = text.split('\n');
  const html = [];
  let i = 0;

  const isBlank = (l) => !l || !l.trim();
  const codeMatch = (l) => new RegExp(`^${CODE_TOKEN}(\\d+)${TOKEN_END}$`).exec(l.trim());
  const isHr = (l) => /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(l);
  const heading = (l) => /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/.exec(l);
  const isList = (l) => /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/.test(l);
  // 注意：正文已整体转义，引用标记在文本里是 `&gt;` 而不是 `>`
  const isQuote = (l) => /^ {0,3}&gt;/.test(l);
  const quoteStrip = (l) => l.replace(/^ {0,3}&gt;[ \t]?/, '');
  const tableSep = (l) => /^ {0,3}\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/.test(l);

  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) { i += 1; continue; }

    const cm = codeMatch(line);
    if (cm) { html.push(blocks[Number(cm[1])]); i += 1; continue; }

    if (isHr(line)) { html.push('<hr>'); i += 1; continue; }

    const h = heading(line);
    if (h) {
      const level = Math.min(h[1].length + 1, 6);
      html.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i += 1;
      continue;
    }

    // 表格：当前行含 | 且下一行是分隔行
    if (line.includes('|') && i + 1 < lines.length && tableSep(lines[i + 1])) {
      const headCells = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && !isBlank(lines[i])) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      html.push(buildTable(headCells, rows));
      continue;
    }

    // 引用
    if (isQuote(line)) {
      const buf = [];
      while (i < lines.length && isQuote(lines[i])) {
        buf.push(quoteStrip(lines[i]));
        i += 1;
      }
      // 引用块内的代码块占位符属于外层，递归后需要还原
      const inner = renderMarkdown(unescapeForNested(buf.join('\n')))
        .replace(new RegExp(`${CODE_TOKEN}(\\d+)${TOKEN_END}`, 'g'),
          (_m, n) => blocks[Number(n)] ?? '');
      html.push(`<blockquote>${inner}</blockquote>`);
      continue;
    }

    // 列表
    if (isList(line)) {
      const { markup, consumed } = buildList(lines, i);
      html.push(markup);
      i = consumed;
      continue;
    }

    // 段落
    const para = [];
    while (i < lines.length && !isBlank(lines[i]) && !codeMatch(lines[i])
           && !heading(lines[i]) && !isHr(lines[i]) && !isList(lines[i])
           && !isQuote(lines[i])) {
      para.push(lines[i]);
      i += 1;
    }
    html.push(`<p>${para.map((l) => inline(l)).join('<br>')}</p>`);
  }

  return html.join('\n');
}

/* 引用块内是已转义文本，递归渲染前需要还原一次，避免二次转义 */
function unescapeForNested(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function splitRow(line) {
  let l = line.trim();
  if (l.startsWith('|')) l = l.slice(1);
  if (l.endsWith('|')) l = l.slice(0, -1);
  return l.split('|').map((c) => c.trim());
}

function buildTable(head, rows) {
  const thead = `<thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>`;
  const tbody = rows.length
    ? `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody>`
    : '';
  return `<table>${thead}${tbody}</table>`;
}

/** 支持一层嵌套的列表 */
function buildList(lines, start) {
  const first = /^ {0,3}([-*+]|\d{1,9}[.)])[ \t]+/.exec(lines[start]);
  const ordered = /^\d/.test(first[1]);
  const items = [];
  let i = start;

  while (i < lines.length) {
    const m = /^ {0,3}([-*+]|\d{1,9}[.)])[ \t]+(.*)$/.exec(lines[i]);
    if (!m) {
      // 续行（缩进）接到上一项
      if (items.length && /^\s+\S/.test(lines[i])) {
        items[items.length - 1] += `<br>${inline(lines[i].trim())}`;
        i += 1;
        continue;
      }
      break;
    }
    let content = m[2];
    i += 1;

    // 收集该列表项的后续行（含嵌套子列表）
    const sub = [];
    while (i < lines.length && /^\s+\S/.test(lines[i]) && !/^ {0,3}([-*+]|\d{1,9}[.)])[ \t]+/.test(lines[i])) {
      sub.push(lines[i].trim());
      i += 1;
    }
    let inner = inline(content);
    if (sub.length) inner += `<br>${sub.map((s) => inline(s)).join('<br>')}`;
    items.push(`<li>${inner}</li>`);
  }

  const tag = ordered ? 'ol' : 'ul';
  const startAttr = ordered && Number(first[1].replace(/\D/g, '')) > 1
    ? ` start="${Number(first[1].replace(/\D/g, ''))}"` : '';
  return { markup: `<${tag}${startAttr}>${items.join('')}</${tag}>`, consumed: i };
}
