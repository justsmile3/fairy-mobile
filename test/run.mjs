#!/usr/bin/env node
/**
 * run.mjs —— 不依赖浏览器的契约测试
 *
 * 覆盖所有纯逻辑：Markdown 渲染、人设拼装、请求消息构造、SSE 流式解析。
 * 浏览器专有的部分（IndexedDB、Web Speech、立绘渲染）由手工验收覆盖，
 * 见 README 的「验收清单」。
 *
 * 用法: node test/run.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ── 极简测试框架 ─────────────────────────────────────── */

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message.split('\n')[0]}`);
  }
}

function group(title) {
  console.log(`\n${title}`);
}

/* ── 浏览器全局的替身 ─────────────────────────────────── */

const memory = new Map();
globalThis.localStorage = {
  getItem: (k) => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => memory.set(k, String(v)),
  removeItem: (k) => memory.delete(k),
  clear: () => memory.clear(),
};

const { renderMarkdown, escapeHtml } = await import('../js/markdown.js');
const { buildSystemPrompt, titleFromText, resolveOwner } = await import('../js/persona.js');
const { normalizeBaseUrl, buildRequestMessages, streamChat, ApiError } = await import('../js/api.js');

/* ── Markdown ─────────────────────────────────────────── */

group('Markdown 渲染');

await test('转义 HTML，阻断标签注入', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)>');
  assert.ok(!html.includes('<img'), `不应出现原始 img 标签: ${html}`);
  assert.ok(html.includes('&lt;img'), '尖括号应被转义');
});

await test('围栏代码块生成带复制按钮的容器，且内容被转义', () => {
  const html = renderMarkdown('```js\nconst a = 1 < 2;\n```');
  assert.ok(html.includes('class="code-block"'), '应有 code-block 容器');
  assert.ok(html.includes('data-copy'), '应有复制按钮');
  assert.ok(html.includes('1 &lt; 2'), '代码内容应被转义');
  assert.ok(html.includes('>js<'), '应显示语言标签');
});

await test('未闭合的代码块（流式中间态）也能渲染', () => {
  const html = renderMarkdown('说明：\n\n```py\nprint(1)');
  assert.ok(html.includes('class="code-block"'), '未闭合代码块也应有容器');
  assert.ok(html.includes('print(1)'), '内容应保留');
});

await test('代码块内的 Markdown 记号不被当作语法', () => {
  const html = renderMarkdown('```\n**不是粗体** [不是链接](http://x)\n```');
  assert.ok(!html.includes('<strong>'), '代码块内不应生成 strong');
  assert.ok(!html.includes('<a '), '代码块内不应生成链接');
});

await test('行内代码 / 粗体 / 斜体 / 删除线', () => {
  const html = renderMarkdown('这是 `code` 与 **粗** 和 *斜* 还有 ~~删~~。');
  assert.ok(html.includes('<code>code</code>'));
  assert.ok(html.includes('<strong>粗</strong>'));
  assert.ok(html.includes('<em>斜</em>'));
  assert.ok(html.includes('<del>删</del>'));
});

await test('链接保留安全协议并补 rel', () => {
  const html = renderMarkdown('[站点](https://example.com/a)');
  assert.ok(html.includes('href="https://example.com/a"'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
});

await test('javascript: 伪协议被剥离，只留文字', () => {
  const html = renderMarkdown('[点我](javascript:alert(1))');
  assert.ok(!html.includes('javascript:'), `不应保留伪协议: ${html}`);
  assert.ok(html.includes('点我'), '文字应保留');
});

await test('图片降级为 alt 文本，避免远程请求', () => {
  const html = renderMarkdown('![图标](https://evil.example/x.png)');
  assert.ok(!html.includes('<img'), '不应渲染 img');
  assert.ok(html.includes('图标'), 'alt 文本应保留');
});

await test('标题 / 分隔线 / 引用 / 列表', () => {
  const html = renderMarkdown('# 一级\n\n---\n\n> 引用内容\n\n- 甲\n- 乙\n\n1. 一\n2. 二');
  assert.ok(html.includes('<h2>一级</h2>'), 'H1 应映射到 h2（页面已有 h1）');
  assert.ok(html.includes('<hr>'));
  assert.ok(html.includes('<blockquote>') && html.includes('引用内容'));
  assert.ok(html.includes('<ul><li>甲</li><li>乙</li></ul>'));
  assert.ok(html.includes('<ol><li>一</li><li>二</li></ol>'));
});

await test('表格渲染', () => {
  const html = renderMarkdown('| 名称 | 数值 |\n| --- | --- |\n| 甲 | 1 |');
  assert.ok(html.includes('<table>'));
  assert.ok(html.includes('<th>名称</th>'));
  assert.ok(html.includes('<td>甲</td>'));
});

await test('段落内单换行保留为 <br>', () => {
  const html = renderMarkdown('第一行\n第二行');
  assert.ok(html.includes('第一行<br>第二行'), `实际: ${html}`);
});

await test('空输入返回空串', () => {
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown('   \n  '), '');
});

await test('escapeHtml 覆盖五个危险字符', () => {
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});

await test('中文与 emoji 不被破坏', () => {
  const html = renderMarkdown('空洞反应：稳定 ✅');
  assert.ok(html.includes('空洞反应：稳定 ✅'));
});

/* ── 人设 ─────────────────────────────────────────────── */

group('Fairy 人设');

await test('启用时包含身份核心、主人身份与移动端能力边界', () => {
  const prompt = buildSystemPrompt({ personaEnabled: true, owner: '铃' });
  assert.ok(prompt.includes('Ⅲ型总序式集成泛用人工智能'), '应含身份核心');
  assert.ok(prompt.includes('铃'), '应写入主人身份');
  assert.ok(prompt.includes('移动端能力边界'), '应含移动端边界说明');
  assert.ok(prompt.includes('没有'), '应明确说明没有工具面');
});

await test('自定义主人称呼生效，空值回落为「主人」', () => {
  assert.equal(resolveOwner({ owner: '自定义', ownerCustom: '  小哲  ' }), '小哲');
  assert.equal(resolveOwner({ owner: '自定义', ownerCustom: '   ' }), '主人');
  assert.equal(resolveOwner({ owner: '哲' }), '哲');
});

await test('关闭人设后不包含 Fairy 身份，只保留追加提示词', () => {
  const prompt = buildSystemPrompt({ personaEnabled: false, extraPrompt: '只说要点。' });
  assert.ok(!prompt.includes('Fairy 是驻留于 HDD'), '不应含身份核心');
  assert.ok(prompt.includes('只说要点。'));
  assert.equal(buildSystemPrompt({ personaEnabled: false, extraPrompt: '' }), '');
});

await test('追加提示词会拼进最终 prompt', () => {
  const prompt = buildSystemPrompt({ personaEnabled: true, owner: '铃', extraPrompt: '回答尽量短。' });
  assert.ok(prompt.includes('【主人追加的指示】'));
  assert.ok(prompt.includes('回答尽量短。'));
});

await test('会话标题取自首句并截断', () => {
  assert.equal(titleFromText('帮我写一个排序算法。后面还有很多话'), '帮我写一个排序算法');
  assert.equal(titleFromText(''), '新的委托');
  assert.equal(titleFromText('   '), '新的委托');
  const long = titleFromText('一'.repeat(50));
  assert.ok(long.length <= 19, `标题应截断，实际长度 ${long.length}`);
  assert.ok(long.endsWith('…'));
});

/* ── API 辅助 ─────────────────────────────────────────── */

group('API 辅助');

await test('normalizeBaseUrl 去掉尾斜杠与 /v1', () => {
  assert.equal(normalizeBaseUrl('https://api.deepseek.com/'), 'https://api.deepseek.com');
  assert.equal(normalizeBaseUrl('https://api.deepseek.com/v1/'), 'https://api.deepseek.com');
  assert.equal(normalizeBaseUrl(''), 'https://api.deepseek.com');
  assert.equal(normalizeBaseUrl(undefined), 'https://api.deepseek.com');
});

await test('buildRequestMessages 过滤报错与空内容，并保证以 user 开头', () => {
  const messages = buildRequestMessages('SYS', [
    { role: 'user', content: '第一条' },
    { role: 'assistant', content: '回复' },
    { role: 'assistant', content: '出错了', error: true },
    { role: 'user', content: '   ' },
    { role: 'assistant', content: '' },
    { role: 'user', content: '第二条' },
  ]);
  assert.equal(messages[0].role, 'system');
  assert.deepEqual(messages.slice(1).map((m) => m.content), ['第一条', '回复', '第二条']);
});

await test('buildRequestMessages 裁剪历史后不会以 assistant 开头', () => {
  const history = [];
  for (let i = 0; i < 30; i += 1) {
    history.push({ role: 'user', content: `u${i}` });
    history.push({ role: 'assistant', content: `a${i}` });
  }
  const messages = buildRequestMessages('SYS', history, { maxTurns: 5 });
  assert.ok(messages.length <= 6, `应被裁剪，实际 ${messages.length}`);
  assert.equal(messages[1].role, 'user', '首条（system 之后）必须是 user');
});

await test('无 system prompt 时不插入 system 消息', () => {
  const messages = buildRequestMessages('', [{ role: 'user', content: '你好' }]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
});

/* ── SSE 流式解析 ─────────────────────────────────────── */

group('SSE 流式解析');

function sseResponse(chunks, { status = 200 } = {}) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

function collect() {
  const out = { content: '', reasoning: '', usage: null, calls: [] };
  return {
    out,
    handlers: {
      onContent: (t) => { out.content += t; },
      onReasoning: (t) => { out.reasoning += t; },
      onUsage: (u) => { out.usage = u; },
    },
  };
}

await test('解析 content 增量并拼接', async () => {
  const original = globalThis.fetch;
  const { out, handlers } = collect();
  globalThis.fetch = async () => sseResponse([
    'data: {"choices":[{"delta":{"content":"检测"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"完毕"}}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  try {
    await streamChat({ apiKey: 'k', baseUrl: 'https://x', model: 'm', messages: [] }, handlers);
  } finally { globalThis.fetch = original; }
  assert.equal(out.content, '检测完毕');
});

await test('解析 reasoning_content 增量', async () => {
  const original = globalThis.fetch;
  const { out, handlers } = collect();
  globalThis.fetch = async () => sseResponse([
    'data: {"choices":[{"delta":{"reasoning_content":"先想"}}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning_content":"再答"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"结论"}}]}\n\n',
  ]);
  try {
    await streamChat({ apiKey: 'k', baseUrl: 'https://x', model: 'm', messages: [] }, handlers);
  } finally { globalThis.fetch = original; }
  assert.equal(out.reasoning, '先想再答');
  assert.equal(out.content, '结论');
});

await test('容忍跨 chunk 截断的事件与 \\r\\n 行尾', async () => {
  const original = globalThis.fetch;
  const { out, handlers } = collect();
  globalThis.fetch = async () => sseResponse([
    'data: {"choices":[{"delta":{"cont',
    'ent":"半"}}]}\r\n\r\n',
    'data: {"choices":[{"delta":{"content":"句"}}]}\n\n',
  ]);
  try {
    await streamChat({ apiKey: 'k', baseUrl: 'https://x', model: 'm', messages: [] }, handlers);
  } finally { globalThis.fetch = original; }
  assert.equal(out.content, '半句');
});

await test('捕获 usage 与注释行、坏 JSON 不致命', async () => {
  const original = globalThis.fetch;
  const { out, handlers } = collect();
  globalThis.fetch = async () => sseResponse([
    ': keep-alive\n\n',
    'data: 这不是 JSON\n\n',
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n',
  ]);
  try {
    await streamChat({ apiKey: 'k', baseUrl: 'https://x', model: 'm', messages: [] }, handlers);
  } finally { globalThis.fetch = original; }
  assert.equal(out.content, 'ok');
  assert.deepEqual(out.usage, { prompt_tokens: 7, completion_tokens: 3 });
});

await test('HTTP 错误翻译成中文 ApiError', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { message: 'Authentication Fails' } }),
    { status: 401 },
  );
  try {
    await assert.rejects(
      () => streamChat({ apiKey: 'bad', baseUrl: 'https://x', model: 'm', messages: [] }, {}),
      (err) => {
        assert.ok(err instanceof ApiError, '应为 ApiError');
        assert.equal(err.status, 401);
        assert.ok(err.message.includes('API Key 无效'), `实际: ${err.message}`);
        assert.ok(err.message.includes('Authentication Fails'), '应保留原始信息');
        return true;
      },
    );
  } finally { globalThis.fetch = original; }
});

await test('端点不支持 stream_options 时自动去掉并重试', async () => {
  const original = globalThis.fetch;
  const bodies = [];
  const { out, handlers } = collect();
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    if (bodies.length === 1) {
      return new Response(JSON.stringify({ error: { message: 'unknown field stream_options' } }), { status: 400 });
    }
    return sseResponse(['data: {"choices":[{"delta":{"content":"重试成功"}}]}\n\n']);
  };
  try {
    await streamChat({ apiKey: 'k', baseUrl: 'https://x', model: 'm', messages: [] }, handlers);
  } finally { globalThis.fetch = original; }
  assert.equal(bodies.length, 2, '应重试一次');
  assert.ok(bodies[0].stream_options, '首次带 stream_options');
  assert.equal(bodies[1].stream_options, undefined, '重试时去掉 stream_options');
  assert.equal(out.content, '重试成功');
});

await test('请求体包含鉴权头与流式开关', async () => {
  const original = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return sseResponse(['data: [DONE]\n\n']);
  };
  try {
    await streamChat({
      apiKey: '  sk-test  ', baseUrl: 'https://api.deepseek.com/',
      model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7, maxTokens: 1024,
    }, {});
  } finally { globalThis.fetch = original; }
  assert.equal(captured.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(captured.init.headers.Authorization, 'Bearer sk-test', 'Key 应去除首尾空格');
  const body = JSON.parse(captured.init.body);
  assert.equal(body.stream, true);
  assert.equal(body.temperature, 0.7);
  assert.equal(body.max_tokens, 1024);
});

await test('网络异常包装成可读错误', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  try {
    await assert.rejects(
      () => streamChat({ apiKey: 'k', baseUrl: 'https://x', model: 'm', messages: [] }, {}),
      (err) => {
        assert.equal(err.code, 'network');
        assert.ok(err.message.includes('网络'), `实际: ${err.message}`);
        return true;
      },
    );
  } finally { globalThis.fetch = original; }
});

/* ── 可选模块（由并行任务产出，缺失则跳过） ───────────── */

group('可选模块');

const optionalModules = [
  { file: '../js/speech.js', exports: ['createTts', 'createStt', 'stripForSpeech', 'chunkForSpeech', 'isSpeechSynthesisSupported', 'isRecognitionSupported'] },
  { file: '../js/mascot.js', exports: ['createMascot'] },
];

for (const mod of optionalModules) {
  const abs = path.join(ROOT, 'js', path.basename(mod.file));
  const exists = fs.existsSync(abs);
  await test(`${path.basename(mod.file)} ${exists ? '导出契约' : '尚未生成（跳过）'}`, async () => {
    if (!exists) return;
    const loaded = await import(mod.file);
    for (const name of mod.exports) {
      assert.equal(typeof loaded[name], 'function', `缺少导出: ${name}`);
    }
  });
}

/* ── 静态资源自检 ─────────────────────────────────────── */

group('静态资源');

await test('index.html 引用的本地资源都存在', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !/^(https?:|data:|#|mailto:)/.test(u));
  for (const ref of refs) {
    const target = path.join(ROOT, ref);
    assert.ok(fs.existsSync(target), `index.html 引用了不存在的文件: ${ref}`);
  }
});

await test('manifest 里的图标文件都存在', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
  assert.ok(manifest.icons.length >= 3, '至少需要 3 个图标');
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'), '需要 maskable 图标');
  for (const icon of manifest.icons) {
    assert.ok(fs.existsSync(path.join(ROOT, icon.src)), `缺少图标: ${icon.src}`);
  }
});

await test('Service Worker 预缓存清单中的文件都存在', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const block = /const APP_SHELL = \[([\s\S]*?)\];/.exec(sw);
  assert.ok(block, '未能解析 APP_SHELL');
  const entries = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(entries.length > 5, '预缓存清单过短');
  for (const entry of entries) {
    if (entry === './') continue;
    const target = path.join(ROOT, entry.replace(/^\.\//, ''));
    assert.ok(fs.existsSync(target), `SW 预缓存了不存在的文件: ${entry}`);
  }
});

await test('CSS 中的类名引用与 JS 大致一致（抽查关键选择器）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'css', 'app.css'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'js', 'main.js'), 'utf8');
  const ids = [...main.matchAll(/\$\('#([a-z0-9-]+)'\)/gi)].map((m) => m[1]);
  const missing = [...new Set(ids)].filter((id) => !css.includes(`#${id}`) && !fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').includes(`id="${id}"`));
  assert.deepEqual(missing, [], `main.js 引用了不存在的元素 id: ${missing.join(', ')}`);
});

/* ── 汇总 ─────────────────────────────────────────────── */

console.log(`\n${'─'.repeat(52)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed) {
  console.log('\n失败详情：');
  for (const f of failures) {
    console.log(`\n✗ ${f.name}\n${f.err.stack}`);
  }
  process.exit(1);
}
console.log('全部通过。');
