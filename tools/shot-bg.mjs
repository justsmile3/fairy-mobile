#!/usr/bin/env node
/**
 * shot-bg.mjs —— 截图查看背景观感
 *
 * 用途：验证程序化背景的视觉效果。像素断言只能证明"画了东西"，
 * 证明不了"好不好看" —— 这个脚本把真实渲染结果存成 PNG，供人眼确认。
 *
 * 用法：node tools/shot-bg.mjs [输出路径]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'www', 'index.html');
const OUT = process.argv[2] || path.join(ROOT, 'dist', 'bg-shot.png');
const PORT = 9887 + (process.pid % 100);

const BROWSERS = [
  process.env.FAIRY_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean);

async function main() {
  if (!fs.existsSync(ENTRY)) {
    console.error('✗ 找不到 assets。请先运行 node tools/build-apk.mjs');
    process.exit(1);
  }
  const browser = BROWSERS.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (!browser) { console.error('✗ 未找到 Edge/Chrome'); process.exit(1); }

  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-crashpad',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(os.tmpdir(), `fairy-shot-${Date.now()}`)}`,
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  let ws = null;
  try {
    const target = await waitForTarget();
    ws = await connect(target.webSocketDebuggerUrl);
    await ws.send('Runtime.enable');
    await ws.send('Page.enable');

    // 手机视口
    await ws.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    });

    const url = `file:///${ENTRY.replace(/\\/g, '/')}`;
    await ws.send('Page.navigate', { url });

    // 等背景画布渲染出来
    await waitForEval(ws, `!!document.querySelector('#hdd-bg')`, 15000);
    await sleep(1200);   // 让扫描线与网格有机会重绘几帧

    const shot = await ws.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
    console.log(`已保存：${OUT}`);
  } catch (err) {
    console.error(`✗ 截图失败：${err.message}`);
    process.exitCode = 1;
  } finally {
    try { ws?.close(); } catch { /* 忽略 */ }
    try { child.kill(); } catch { /* 忽略 */ }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
