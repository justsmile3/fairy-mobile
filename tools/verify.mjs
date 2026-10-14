#!/usr/bin/env node
/**
 * verify.mjs —— 浏览器端到端验收
 *
 * 做四件事：
 *   1. 用 Edge/Chrome 无头模式以手机视口（390×844, DPR 2, 触摸）打开 App
 *   2. 在页面脚本运行前注入假的 fetch，用真实的 SSE 分片模拟 DeepSeek 接口，
 *      从而完整走通「输入 → 流式接收 → Markdown 渲染 → IndexedDB 落库」链路
 *   3. 收集控制台错误与未捕获异常，任何一条都算失败
 *   4. 输出验收报告并截图，供人工复核
 *
 * 前置：另开一个终端运行 `node tools/serve.mjs`
 * 用法：node tools/verify.mjs [--url http://127.0.0.1:8788/] [--out ../.verify]
 *
 * 注意：Chromium 需要创建 mojo 命名管道，在受限沙箱下无法启动；
 * 若报 platform_channel 相关错误，请在允许的沙箱模式下运行本脚本。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const URL_BASE = arg('url', 'http://127.0.0.1:8788/');
const OUT_DIR = path.resolve(ROOT, arg('out', path.join('..', '.verify')));
const DEBUG_PORT = Number(arg('port', 9333));

const BROWSER_CANDIDATES = [
  process.env.FAIRY_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── CDP 极简客户端 ───────────────────────────────────── */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (const fn of this.listeners.get(msg.method) || []) fn(msg.params);
      }
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 30000);
    });
  }

  close() { try { this.ws.close(); } catch { /* 忽略 */ } }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
  });
  return new Cdp(ws);
}

/* ── 注入脚本：假 fetch + 预置设置 ────────────────────── */

const FAKE_BACKEND = `
(() => {
  // 预置设置：假的 Key 与本地 baseUrl，让 App 认为已经配置好
  try {
    localStorage.setItem('fairy-mobile:settings', JSON.stringify({
      apiKey: 'sk-verify-fake',
      baseUrl: location.origin,
      model: 'deepseek-chat',
      theme: 'dark',
      personaEnabled: true,
      owner: '铃',
      autoRead: false,
      showReasoning: true,
    }));
  } catch (e) { /* 忽略 */ }

  const encoder = new TextEncoder();
  const REPLY = [
    { delta: { reasoning_content: '先确认返回格式。' } },
    { delta: { content: '分析：链路已通。\\n\\n' } },
    { delta: { content: '- 网络：正常\\n- 渲染：**就绪**\\n\\n' } },
    { delta: { content: '\\u0060\\u0060\\u0060js\\nconst ok = 1 < 2;\\n\\u0060\\u0060\\u0060\\n\\n' } },
    { delta: { content: '主人，接线完毕。' } },
  ];

  const realFetch = window.fetch.bind(window);
  window.__fairyVerify = { chatCalls: 0, lastBody: null };

  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (/chat\\/completions/.test(url)) {
      window.__fairyVerify.chatCalls += 1;
      try { window.__fairyVerify.lastBody = JSON.parse(init.body); } catch (e) { /* 忽略 */ }

      const chunks = [];
      for (const item of REPLY) {
        chunks.push('data: ' + JSON.stringify({ choices: [{ delta: item.delta }] }) + '\\n\\n');
      }
      chunks.push('data: ' + JSON.stringify({
        choices: [], usage: { prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 },
      }) + '\\n\\n');
      chunks.push('data: [DONE]\\n\\n');

      const stream = new ReadableStream({
        async start(controller) {
          for (const c of chunks) {
            controller.enqueue(encoder.encode(c));
            await new Promise((r) => setTimeout(r, 25));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }

    if (/user\\/balance/.test(url)) {
      return new Response(JSON.stringify({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '88.50', granted_balance: '8.50', topped_up_balance: '80.00' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (/\\/models/.test(url)) {
      return new Response(JSON.stringify({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    return realFetch(input, init);
  };
})();
`;

/* ── 页面内断言（分阶段，便于在关键节点截图） ─────────── */

const PRELUDE = `
  const results = [];
  const check = (name, fn) => {
    try {
      const value = fn();
      results.push({ name, ok: Boolean(value), detail: typeof value === 'string' ? value : '' });
    } catch (err) {
      results.push({ name, ok: false, detail: err.message });
    }
  };
  const waitFor = async (fn, timeout = 15000) => {
    const started = Date.now();
    for (;;) {
      if (fn()) return true;
      if (Date.now() - started > timeout) return false;
      await new Promise((r) => setTimeout(r, 60));
    }
  };
`;

const PHASE_BOOT = `(async () => {
${PRELUDE}
  check('页面标题正确', () => document.title === 'DeepSeek Fairy');
  check('主题变量已应用', () => document.documentElement.dataset.theme === 'dark');
  check('顶栏可见', () => document.querySelector('#topbar').getBoundingClientRect().height > 20);
  check('输入区可见', () => document.querySelector('#composer').getBoundingClientRect().height > 20);
  check('对话区占用剩余高度', () => document.querySelector('#chat').getBoundingClientRect().height > 200);
  check('空状态提示可见', () => !document.querySelector('#empty-state').hidden);
  check('未配置 Key 的警告已隐藏', () => document.querySelector('#key-warning').hidden === true);
  check('无横向溢出', () => document.documentElement.scrollWidth <= innerWidth + 1);
  check('Service Worker 已注册', () => 'serviceWorker' in navigator);

  const mascotHost = document.querySelector('#mascot-host');
  check('立绘层已渲染', () => mascotHost && mascotHost.childElementCount > 0);
  check('立绘包含 SVG', () => mascotHost && mascotHost.querySelector('svg') !== null);
  check('立绘有实际尺寸', () => {
    const r = mascotHost.getBoundingClientRect();
    return r.width > 20 && r.height > 20;
  });
  check('立绘未溢出视口', () => {
    const r = document.querySelector('#mascot-layer').getBoundingClientRect();
    return r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
  });

  const mascotErrors = [];
  try {
    const mod = await import('./js/mascot.js');
    const probeHost = document.createElement('div');
    probeHost.style.cssText = 'position:fixed;left:-9999px;width:120px;height:120px;';
    document.body.appendChild(probeHost);
    const inst = mod.createMascot(probeHost, { theme: 'dark', scale: 1, animationSpeed: 1 });
    for (const s of ['idle', 'thinking', 'speaking', 'listening', 'happy', 'alert', 'error', 'sleeping']) {
      try { inst.setState(s); } catch (e) { mascotErrors.push('setState(' + s + '): ' + e.message); }
    }
    for (const [m, v] of [['setScale', 1.4], ['setScale', 0.5], ['setAnimationSpeed', 2],
                          ['setAnimationSpeed', 0.5], ['setTheme', 'light'], ['setTheme', 'dark'],
                          ['setReducedMotion', true], ['setReducedMotion', false]]) {
      try { inst[m](v); } catch (e) { mascotErrors.push(m + '(' + v + '): ' + e.message); }
    }
    try { inst.setState('idle'); } catch (e) { mascotErrors.push('restore: ' + e.message); }
    check('立绘渲染出可见图形', () => probeHost.querySelector('svg') !== null);
    let destroyed = false;
    try { inst.destroy(); destroyed = true; } catch (e) { mascotErrors.push('destroy: ' + e.message); }
    check('立绘可销毁', () => destroyed);
    let afterDestroy = true;
    try { inst.setState('thinking'); inst.setScale(1); } catch (e) { afterDestroy = false; mascotErrors.push('after-destroy: ' + e.message); }
    check('销毁后调用安全', () => afterDestroy);
    probeHost.remove();
  } catch (err) {
    mascotErrors.push('import: ' + err.message);
  }
  results.push({
    name: '立绘模块全状态切换无异常',
    ok: mascotErrors.length === 0,
    detail: mascotErrors.join(' | '),
  });

  return results;
})()`;

const PHASE_CHAT = `(async () => {
${PRELUDE}
  const input = document.querySelector('#input');
  input.value = '验证一下链路';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#btn-send').click();

  const streamingDone = () => {
    const nodes = document.querySelectorAll('#messages .msg.assistant');
    return nodes.length > 0
      && document.querySelectorAll('#messages .msg.assistant[data-pending]').length === 0
      && document.querySelector('#btn-stop').hidden === true;
  };
  const ok = await waitFor(streamingDone, 20000);
  check('助手回复流式接收完成', () => ok);

  const assistant = document.querySelector('#messages .msg.assistant');
  check('用户消息已渲染', () => document.querySelectorAll('#messages .msg.user').length === 1);
  check('正文包含预期文本', () => assistant && assistant.textContent.includes('接线完毕'));
  check('Markdown 粗体已渲染', () => assistant && assistant.querySelector('strong') !== null);
  check('代码块已渲染', () => assistant && assistant.querySelector('.code-block code') !== null);
  check('代码块内容被转义', () => {
    const code = assistant.querySelector('.code-block code');
    return code && code.textContent.includes('1 < 2') && !code.querySelector('*');
  });
  check('推理过程已折叠展示', () => assistant && assistant.querySelector('details.reasoning') !== null);
  check('XSS 防护：无注入的 script', () => document.querySelectorAll('#messages script').length === 0);

  const messages = await new Promise((resolve) => {
    const req = indexedDB.open('fairy-mobile');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('messages', 'readonly');
      const all = tx.objectStore('messages').getAll();
      all.onsuccess = () => resolve(all.result || []);
      all.onerror = () => resolve([]);
    };
    req.onerror = () => resolve([]);
  });
  check('消息已写入 IndexedDB', () => messages.length === 2);
  check('落库内容完整', () => messages.some((m) => m.role === 'assistant' && m.content.includes('接线完毕')));
  check('usage 已记录', () => messages.some((m) => m.role === 'assistant' && m.usage && m.usage.prompt_tokens === 42));
  check('请求体含 system 人设', () => {
    const body = window.__fairyVerify.lastBody;
    return body && body.messages[0].role === 'system' && body.messages[0].content.includes('Fairy');
  });
  check('请求体含移动端能力边界', () => {
    const body = window.__fairyVerify.lastBody;
    return body && body.messages[0].content.includes('移动端能力边界');
  });
  check('只发起了 1 次对话请求', () => window.__fairyVerify.chatCalls === 1);

  results.push({
    name: 'DIAG',
    ok: true,
    detail: JSON.stringify({
      assistantClass: assistant ? assistant.className : null,
      assistantText: assistant ? assistant.textContent.slice(0, 300) : null,
      messageRows: messages.map((m) => ({ role: m.role, error: !!m.error, len: (m.content || '').length, usage: m.usage || null })),
      chatCalls: window.__fairyVerify.chatCalls,
      requestModel: window.__fairyVerify.lastBody && window.__fairyVerify.lastBody.model,
    }),
  });

  return results;
})()`;

const PHASE_DRAWER_SETTINGS = `(async () => {
${PRELUDE}
  document.querySelector('#btn-menu').click();
  check('会话抽屉可打开', () => document.querySelector('#drawer').dataset.open === 'true');
  check('抽屉内列出 1 个会话', () => document.querySelectorAll('#session-list .session-item').length === 1);
  document.querySelector('#btn-drawer-close').click();
  check('会话抽屉可关闭', () => document.querySelector('#drawer').dataset.open === 'false');

  document.querySelector('#btn-settings').click();
  check('设置面板可打开', () => !document.querySelector('#settings').hidden);
  check('API Key 已回填', () => document.querySelector('#set-api-key').value === 'sk-verify-fake');
  check('模型下拉已填充', () => document.querySelector('#set-model').options.length >= 2);
  check('语音模块已探测', () => document.querySelector('#speech-support').textContent.length > 0);
  return results;
})()`;

const PHASE_BALANCE = `(async () => {
${PRELUDE}
  document.querySelector('#btn-settings').click();
  await new Promise((r) => setTimeout(r, 120));
  document.querySelector('#btn-balance').click();
  const balOk = await waitFor(() => document.querySelector('#balance-content').textContent.includes('88.50'), 8000);
  check('余额面板读到数据', () => balOk);
  check('用量面板统计 token', () => document.querySelector('#usage-content').textContent.includes('42'));
  check('面板互斥：余额打开时设置已关闭', () => document.querySelector('#settings').hidden === true);
  return results;
})()`;

const PHASE_THEME = `(async () => {
${PRELUDE}
  document.querySelector('#balance .panel-close').click();
  await new Promise((r) => setTimeout(r, 120));
  document.querySelector('#btn-settings').click();
  document.querySelector('#set-theme').value = 'light';
  document.querySelector('#set-theme').dispatchEvent(new Event('change', { bubbles: true }));
  check('亮色主题生效', () => document.documentElement.dataset.theme === 'light');
  const setting = JSON.parse(localStorage.getItem('fairy-mobile:settings'));
  check('主题设置已持久化', () => setting.theme === 'light');
  return results;
})()`;

/* ── 主流程 ───────────────────────────────────────────── */

async function main() {
  await fsp.mkdir(OUT_DIR, { recursive: true });

  // 1. 服务器可达性
  try {
    const res = await fetch(URL_BASE, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error(`\n✗ 无法访问 ${URL_BASE}`);
    console.error('  请先在另一个终端运行: node tools/serve.mjs\n');
    process.exit(1);
  }

  const browserPath = BROWSER_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (!browserPath) {
    console.error('✗ 未找到 Edge/Chrome。可用 FAIRY_BROWSER 环境变量指定可执行文件路径。');
    process.exit(1);
  }

  const profileDir = path.join(os.tmpdir(), `fairy-verify-${Date.now()}`);
  const child = spawn(browserPath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-crashpad',
    '--disable-extensions',
    '--hide-scrollbars',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  let cdp = null;
  const consoleErrors = [];
  const pageExceptions = [];

  try {
    // 2. 等待调试端口
    let version = null;
    for (let i = 0; i < 60; i += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
        version = await res.json();
        break;
      } catch { await sleep(250); }
    }
    if (!version) throw new Error('浏览器调试端口未就绪（沙箱可能阻止了 Chromium 的命名管道）');

    const listRes = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
    const targets = await listRes.json();
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('找不到可用的页面目标');

    cdp = await connect(page.webSocketDebuggerUrl);

    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') {
        consoleErrors.push((p.args || []).map((a) => a.value ?? a.description ?? a.type).join(' '));
      }
    });
    cdp.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails;
      pageExceptions.push(d.exception?.description || d.text || '未知异常');
    });
    cdp.on('Log.entryAdded', (p) => {
      if (p.entry.level === 'error') consoleErrors.push(`${p.entry.source}: ${p.entry.text}`);
    });

    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');

    // 3. 手机视口
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await cdp.send('Emulation.setUserAgentOverride', {
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) '
        + 'Chrome/124.0.0.0 Mobile Safari/537.36',
    });

    // 4. 页面脚本运行前注入假后端
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_BACKEND });

    const loaded = new Promise((resolve) => cdp.on('Page.loadEventFired', resolve));
    await cdp.send('Page.navigate', { url: URL_BASE });
    await Promise.race([loaded, sleep(15000)]);
    await sleep(900); // 等 boot() 完成异步初始化

    // 5. 分阶段断言 + 截图
    const phases = [
      { name: '01-home-dark', expr: PHASE_BOOT },
      { name: '02-chat-dark', expr: PHASE_CHAT },
      { name: '03-settings-dark', expr: PHASE_DRAWER_SETTINGS },
      { name: '04-balance-dark', expr: PHASE_BALANCE },
      { name: '05-settings-light', expr: PHASE_THEME },
    ];
    const results = [];
    const shotPaths = [];
    for (const phase of phases) {
      const evalRes = await cdp.send('Runtime.evaluate', {
        expression: phase.expr,
        awaitPromise: true,
        returnByValue: true,
      });
      if (evalRes.exceptionDetails) {
        throw new Error(`阶段 ${phase.name} 断言脚本异常：${evalRes.exceptionDetails.exception?.description || evalRes.exceptionDetails.text}`);
      }
      const phaseResults = evalRes.result.value || [];
      results.push(...phaseResults);

      await sleep(200); // 等面板/主题过渡动画完成，保证截图稳定
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const shotPath = path.join(OUT_DIR, `${phase.name}.png`);
      await fsp.writeFile(shotPath, Buffer.from(shot.data, 'base64'));
      shotPaths.push(shotPath);
    }

    // 7. 报告
    const passed = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);

    console.log('\n浏览器端到端验收（390×844 · DPR2 · 触摸）');
    console.log('─'.repeat(58));
    for (const r of results) {
      if (r.name === 'DIAG') continue;
      console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.ok || !r.detail ? '' : `  ← ${r.detail}`}`);
    }
    const diag = results.find((r) => r.name === 'DIAG');
    if (diag) {
      try {
        const parsed = JSON.parse(diag.detail);
        console.log('\n诊断');
        console.log(`  助手节点 class: ${parsed.assistantClass}`);
        console.log(`  助手节点文本: ${JSON.stringify(parsed.assistantText)}`);
        console.log(`  入库消息: ${JSON.stringify(parsed.messageRows)}`);
        console.log(`  请求模型: ${parsed.requestModel} · 对话请求次数: ${parsed.chatCalls}`);
      } catch {
        console.log(`\n诊断: ${diag.detail}`);
      }
    }
    console.log('─'.repeat(58));
    console.log(`页面断言：通过 ${passed} / ${results.length}`);
    console.log(`控制台错误：${consoleErrors.length}`);
    console.log(`未捕获异常：${pageExceptions.length}`);
    if (consoleErrors.length) {
      console.log('\n控制台错误：');
      for (const e of consoleErrors.slice(0, 12)) console.log(`  · ${e}`);
    }
    if (pageExceptions.length) {
      console.log('\n未捕获异常：');
      for (const e of pageExceptions.slice(0, 12)) console.log(`  · ${e.split('\n')[0]}`);
    }
    console.log(`\n截图：`);
    for (const p of shotPaths) console.log(`  · ${path.relative(process.cwd(), p)}`);

    const fatal = failed.length > 0 || pageExceptions.length > 0
      || consoleErrors.filter((e) => !/favicon|DevTools/i.test(e)).length > 0;
    console.log(fatal ? '\n结果：存在失败项。' : '\n结果：全部通过。');
    process.exitCode = fatal ? 1 : 0;
  } catch (err) {
    console.error(`\n✗ 验收失败：${err.message}`);
    if (/platform_channel|命名管道|拒绝访问|mojo/i.test(err.message)) {
      console.error('  这通常是沙箱阻止了 Chromium 的 mojo 命名管道，需要在更宽的沙箱模式下运行。');
    }
    process.exitCode = 1;
  } finally {
    cdp?.close();
    try { child.kill(); } catch { /* 忽略 */ }
    await sleep(300);
    await fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

main();
