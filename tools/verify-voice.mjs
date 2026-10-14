#!/usr/bin/env node
/**
 * verify-voice.mjs —— 验证「语音状态文案」在各种配置下都准确
 *
 * 为什么需要这个测试：
 *   语音出问题时，界面上的提示是唯一的线索。若提示写死或与真实配置矛盾，
 *   排障就会被误导（项目早期就踩过这个坑）。
 *
 * 本测试把不同的设置组合喂给云语音配置解析逻辑，断言：
 *   - 缺少 Key 时必须提示「需要 API Key」，而不是笼统说「不可用」
 *   - 选了 SiliconFlow 且填了音色时，必须体现「克隆音色」
 *   - 未配置时的默认后端必须是免注册的百度（保证开箱能出声）
 *   - 自定义服务缺 URL 时必须明确指出来
 *
 * 用法：node tools/verify-voice.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'www', 'index.html');
const PORT = 9611 + (process.pid % 200);

const BROWSERS = [
  process.env.FAIRY_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean);

/**
 * 各场景：设置覆盖 + 对状态文案的断言。
 * 匹配用正则，避免文案微调就失败。
 */
const SCENARIOS = [
  {
    name: '未做任何配置',
    settings: {},
    expect: /百度/,
    why: '开箱即用：不配置也应该有可用的免注册后端',
  },
  {
    name: '选了 SiliconFlow 但没填 Key',
    settings: { ttsProvider: 'siliconflow' },
    expect: /API Key/,
    why: '必须明确指出缺 Key，而不是笼统说不可用',
  },
  {
    name: 'SiliconFlow 已配置（预置音色）',
    settings: { ttsProvider: 'siliconflow', sfApiKey: 'sk-test-123' },
    expect: /SiliconFlow/,
    why: '配置完整时应显示服务名',
  },
  {
    name: 'SiliconFlow + 克隆音色',
    settings: { ttsProvider: 'siliconflow', sfApiKey: 'sk-test-123', sfVoice: 'speech:fairy:abc:def' },
    expect: /克隆/,
    why: '用了克隆音色要让用户知道',
  },
  {
    name: '自定义服务但没填 URL',
    settings: { ttsProvider: 'custom' },
    expect: /Base URL/,
    why: '要指出具体缺哪个字段',
  },
  {
    name: '自定义服务已配置',
    settings: {
      ttsProvider: 'custom',
      customBaseUrl: 'https://example.com/v1',
      customModel: 'tts-1',
    },
    expect: /自定义/,
    why: '配置完整时应显示自定义服务',
  },
  {
    name: '自动选择（有 SiliconFlow Key）',
    settings: { sfApiKey: 'sk-test-123' },
    expect: /SiliconFlow/,
    why: 'auto 模式下填了 Key 应自动升级到 SiliconFlow',
  },
  {
    name: '显式选择百度',
    settings: { ttsProvider: 'baidu', sfApiKey: 'sk-test-123' },
    expect: /百度/,
    why: '显式选择应优先于 auto 规则',
  },
];

async function main() {
  if (!fs.existsSync(ENTRY)) {
    console.error('✗ 找不到 APK assets。请先运行：node tools/build-apk.mjs');
    process.exit(1);
  }
  const browser = BROWSERS.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (!browser) {
    console.error('✗ 未找到 Edge/Chrome。可用 FAIRY_BROWSER 指定路径。');
    process.exit(1);
  }

  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-crashpad',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(os.tmpdir(), `fairy-voice-${Date.now()}`)}`,
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  let ws = null;
  try {
    const target = await waitForTarget();
    ws = await connect(target.webSocketDebuggerUrl);
    await ws.send('Runtime.enable');
    await ws.send('Page.enable');

    // 预置好设置，页面启动时会读取
    const preset = JSON.stringify(Object.fromEntries(
      SCENARIOS.map((s, i) => [`fairy.settings.v1`, null]).filter(() => false),
    ));

    const fileUrl = `file:///${ENTRY.replace(/\\/g, '/')}`;
    await ws.send('Page.navigate', { url: fileUrl });
    await waitForEval(ws, `!!document.querySelector('#mascot-layer svg')`, 15000);

    const results = [];
    for (const scenario of SCENARIOS) {
      const text = await evaluateSettings(ws, scenario.settings);
      const ok = scenario.expect.test(text);
      results.push({ ...scenario, text, ok });
    }

    report(results);
    process.exitCode = results.every((r) => r.ok) ? 0 : 1;
  } catch (err) {
    console.error(`✗ 测试失败：${err.message}`);
    process.exitCode = 1;
  } finally {
    try { ws?.close(); } catch { /* 忽略 */ }
    try { child.kill(); } catch { /* 忽略 */ }
  }
}

/**
 * 在页面里：用**全新的设置对象**计算状态文案 → 返回文案。
 *
 * 注意：每个场景必须从干净的基础设置出发，否则会继承上一场景的字段
 * （例如上一个场景填过的 customBaseUrl 会让 auto 误判为自定义服务，
 * 从而产生假失败）。
 */
async function evaluateSettings(ws, settings) {
  const expr = `
    (async () => {
      const store = window.__fairyTest;
      if (!store) return '(测试钩子缺失)';
      store.resetSettings(${JSON.stringify(JSON.stringify(settings))});
      return store.describeSpeechState();
    })()
  `;
  const r = await ws.send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || '脚本异常');
  }
  return String(r.result.value || '');
}

function waitForEval(ws, expr, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const r = await ws.send('Runtime.evaluate', { expression: expr, returnByValue: true });
        if (r.result?.value) return resolve(true);
      } catch { /* 继续等 */ }
      if (Date.now() > deadline) return reject(new Error(`等待超时：${expr}`));
      setTimeout(tick, 200);
    };
    tick();
  });
}

function report(results) {
  console.log('');
  console.log('语音状态文案验收（各配置场景）');
  console.log('─'.repeat(58));
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}`);
    if (!r.ok) {
      console.log(`      期望匹配：${r.expect}`);
      console.log(`      实际文案：${r.text}`);
      console.log(`      为什么重要：${r.why}`);
    }
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log('─'.repeat(58));
  console.log(`通过 ${results.length - failed} / ${results.length}　场景`);
  console.log('');
}

function waitForTarget(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      http.get({ host: '127.0.0.1', port: PORT, path: '/json/list' }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const page = JSON.parse(body).find((t) => t.type === 'page');
            if (page) resolve(page); else retry();
          } catch { retry(); }
        });
      }).on('error', retry);
    };
    const retry = () => {
      if (Date.now() > deadline) reject(new Error('等待浏览器调试端口超时'));
      else setTimeout(tick, 250);
    };
    tick();
  });
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    socket.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          const msgId = ++id;
          return new Promise((res, rej) => {
            pending.set(msgId, { res, rej });
            socket.send(JSON.stringify({ id: msgId, method, params }));
          });
        },
        close() { socket.close(); },
      });
    });
    socket.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      }
    });
    socket.addEventListener('error', () => reject(new Error('无法连接调试端口')));
  });
}

main();
