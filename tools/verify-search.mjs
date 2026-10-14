#!/usr/bin/env node
/**
 * verify-search.mjs —— 实测联网搜索能否真的取到结果
 *
 * 为什么单独测：搜索依赖抓取公开结果页并解析 HTML，这与站点结构强耦合。
 * 站点改版会让解析静默失效（返回空结果），只有真的发一次请求才能发现。
 *
 * 本测试在 Node 里复现 SearchClient.java 的解析逻辑，对每个搜索引擎
 * 发真实请求并断言能提取到条目。
 *
 * 用法：node tools/verify-search.mjs
 */

import { spawnSync } from 'node:child_process';

const ENGINES = [
  { id: 'bing', label: 'Bing', url: 'https://cn.bing.com/search?q=%s&setlang=zh-CN' },
  { id: 'sogou', label: '搜狗', url: 'https://www.sogou.com/web?query=%s' },
  { id: 'so360', label: '360 搜索', url: 'https://www.so.com/s?q=%s' },
  { id: 'mojeek', label: 'Mojeek', url: 'https://www.mojeek.com/search?q=%s' },
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const QUERY = 'DeepSeek 最新消息';

/** 复现 Java 侧的去标签逻辑 */
function stripTags(s) {
  if (!s) return '';
  let t = s.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '');
  t = t.replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&ensp;/g, ' ').replace(/&emsp;/g, ' ')
    .replace(/&hellip;/g, '…').replace(/&mdash;/g, '—');
  t = t.replace(/&#(\d+);/g, (_, d) => {
    try { return String.fromCharCode(Number(d)); } catch { return ''; }
  });
  return t.replace(/\s+/g, ' ').trim();
}

function parseBing(html, count) {
  const out = [];
  const blocks = html.split('<li class="b_algo"');
  for (let i = 1; i < blocks.length && out.length < count; i++) {
    const m = blocks[i].match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!m) continue;
    const pm = blocks[i].match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    out.push({ title: stripTags(m[2]), url: m[1], snippet: pm ? stripTags(pm[1]) : '' });
  }
  return out;
}

function parseSogou(html, count) {
  const out = [];
  const re = /<h3[^>]*class="[^"]*vr-title[^"]*"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < count) {
    const tail = html.slice(m.index + m[0].length, m.index + m[0].length + 4000);
    const pm = tail.match(/<div[^>]*class="[^"]*(?:text-layout|fz-mid|str_info)[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    out.push({ title: stripTags(m[2]), url: m[1], snippet: pm ? stripTags(pm[1]) : '' });
  }
  return out;
}

function parseSo360(html, count) {
  const out = [];
  const re = /<h3[^>]*class="[^"]*res-title[^"]*"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < count) {
    const tail = html.slice(m.index + m[0].length, m.index + m[0].length + 5000);
    const pm = tail.match(/<p[^>]*class="[^"]*res-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    out.push({ title: stripTags(m[2]), url: m[1], snippet: pm ? stripTags(pm[1]) : '' });
  }
  return out;
}

function parseMojeek(html, count) {
  const out = [];
  const re = /<a[^>]*class="title"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < count) {
    const tail = html.slice(m.index + m[0].length, m.index + m[0].length + 4000);
    const pm = tail.match(/<p[^>]*class="s"[^>]*>([\s\S]*?)<\/p>/i);
    out.push({ title: stripTags(m[2]), url: m[1], snippet: pm ? stripTags(pm[1]) : '' });
  }
  return out;
}

const PARSERS = { bing: parseBing, sogou: parseSogou, so360: parseSo360, mojeek: parseMojeek };

async function testEngine(engine) {
  const url = engine.url.replace('%s', encodeURIComponent(QUERY));
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(25000),
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const html = await res.text();
    const results = PARSERS[engine.id](html, 5);
    if (!results.length) {
      return { ok: false, error: `未能提取条目（页面 ${html.length} 字节）` };
    }
    return { ok: true, results, bytes: html.length };
  } catch (e) {
    return { ok: false, error: e.cause?.code || e.message };
  }
}

async function main() {
  console.log('');
  console.log('联网搜索实测（真实请求 + HTML 解析）');
  console.log('─'.repeat(60));

  let okCount = 0;
  for (const engine of ENGINES) {
    const r = await testEngine(engine);
    if (r.ok) okCount += 1;
    console.log(`  ${r.ok ? '✓' : '✗'} ${engine.label}`);
    if (r.ok) {
      console.log(`      取到 ${r.results.length} 条（页面 ${(r.bytes / 1024).toFixed(0)} KB）`);
      const first = r.results[0];
      console.log(`      示例：${first.title.slice(0, 46)}`);
      if (first.snippet) console.log(`            ${first.snippet.slice(0, 60)}`);
    } else {
      console.log(`      ${r.error}`);
    }
  }

  console.log('─'.repeat(60));
  console.log(`可用引擎 ${okCount} / ${ENGINES.length}`);
  console.log('');
  if (okCount === 0) {
    console.log('✗ 所有引擎都无法取到结果 —— 联网搜索不可用。');
    return 1;
  }
  return 0;
}

main().then((code) => { process.exitCode = code; });
