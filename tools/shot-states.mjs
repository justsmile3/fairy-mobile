#!/usr/bin/env node
/**
 * shot-states.mjs —— 截取多个界面状态
 *
 * 用途：一次改动同时影响多处界面时（例如"立绘从对话区移到抽屉"），
 * 需要逐一看过每个受影响的位置。单张截图证明不了"三处都对"。
 *
 * 截取的状态：
 *   1. splash   —— 启动瞬间的开场动画
 *   2. chat     —— 对话界面（应看不到常驻立绘）
 *   3. drawer   —— 委托记录抽屉（应看到顶部立绘）
 *
 * 用法：node tools/shot-states.mjs [输出目录]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'www', 'index.html');
const OUTDIR = process.argv[2] || path.join(ROOT, 'dist');
const PORT = 9931 + (process.pid % 60);

const BROWSERS = [
  process.env.FAIRY_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!fs.existsSync(ENTRY)) {
    console.error('✗ 找不到 assets，请先运行 node tools/build-apk.mjs');
    process.exit(1);
  }
  const browser = BROWSERS.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (!browser) { console.error('✗ 未找到 Edge/Chrome'); process.exit(1); }

  fs.mkdirSync(OUTDIR, { recursive: true });

  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-crashpad',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(os.tmpdir(), `fairy-states-${Date.now()}`)}`,
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  let ws = null;
  try {
    const target = await waitForTarget();
    ws = await connect(target.webSocketDebuggerUrl);
    await ws.send('Runtime.enable');
    await ws.send('Page.enable');
    await ws.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    });

    const evalJs = async (expr) => {
      const r = await ws.send('Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true,
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || '脚本异常');
      return r.result.value;
    };

    const shot = async (name) => {
      const r = await ws.send('Page.captureScreenshot', { format: 'png' });
      const p = path.join(OUTDIR, `state-${name}.png`);
      fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
      console.log(`  已保存 ${p}`);
    };

    await ws.send('Page.navigate', { url: `file:///${ENTRY.replace(/\\/g, '/')}` });

    // ── 1. 开场动画 ──
    // 尽快截图，赶在动画淡出之前
    await waitForEval(ws, `!!document.querySelector('#splash')`, 15000);
    await sleep(600);
    const splashState = await evalJs(`
      (() => {
        const s = document.querySelector('#splash');
        if (!s) return { gone: true };
        const m = document.querySelector('#splash-mascot');
        return {
          gone: false,
          hidden: s.hidden,
          hasMascotSvg: !!m?.querySelector('svg'),
          opacity: getComputedStyle(s).opacity,
        };
      })()
    `);
    console.log('开场动画：', JSON.stringify(splashState));
    await shot('splash');

    // ── 2. 等动画结束，看对话界面 ──
    await sleep(2200);
    const chatState = await evalJs(`
      (() => {
        const s = document.querySelector('#splash');
        const layer = document.querySelector('#mascot-layer');
        return {
          splashRemoved: !s,
          hasFloatingLayer: !!layer,   // 应为 false：对话区不再有常驻立绘
        };
      })()
    `);
    console.log('对话界面：', JSON.stringify(chatState));
    await shot('chat');

    // ── 3. 打开抽屉看委托记录 ──
    await evalJs(`document.querySelector('#btn-menu')?.click()`);
    await sleep(600);
    const drawerState = await evalJs(`
      (() => {
        const d = document.querySelector('#drawer');
        const m = document.querySelector('.drawer-mascot');
        const svg = document.querySelector('#mascot-host svg');
        const r = m?.getBoundingClientRect();
        return {
          drawerOpen: d && !d.hidden && d.getAttribute('aria-hidden') === 'false',
          mascotExists: !!m,
          mascotVisible: r ? r.width > 0 && r.height > 0 : false,
          mascotSize: r ? [Math.round(r.width), Math.round(r.height)] : null,
          hasSvg: !!svg,
        };
      })()
    `);
    console.log('委托记录：', JSON.stringify(drawerState));
    await shot('drawer');
  } catch (err) {
    console.error(`✗ 失败：${err.message}`);
    process.exitCode = 1;
  } finally {
    try { ws?.close(); } catch { /* 忽略 */ }
    try { child.kill(); } catch { /* 忽略 */ }
  }
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
      if (Date.now() > deadline) reject(new Error('等待调试端口超时'));
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

main();
