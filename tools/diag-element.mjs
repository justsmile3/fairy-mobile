#!/usr/bin/env node
/**
 * diag-element.mjs —— 诊断：某个屏幕坐标上是什么元素
 *
 * 用途：截图里看到一个不该出现的图形时，靠猜是低效的。
 * 这个脚本直接在真实渲染环境里问「这个坐标上是谁」，
 * 并列出立绘区域内所有可见的图层及其几何与透明度。
 *
 * 用法：node tools/diag-element.mjs [x] [y]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'www', 'index.html');
const PORT = 9911 + (process.pid % 80);
const X = Number(process.argv[2] || 224);
const Y = Number(process.argv[3] || 660);

const BROWSERS = [
  process.env.FAIRY_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean);

async function main() {
  const browser = BROWSERS.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (!browser) { console.error('✗ 未找到浏览器'); process.exit(1); }

  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-crashpad',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(os.tmpdir(), `fairy-diag-${Date.now()}`)}`,
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
    await ws.send('Page.navigate', { url: `file:///${ENTRY.replace(/\\/g, '/')}` });
    await waitForEval(ws, `!!document.querySelector('#hdd-bg')`, 15000);
    await sleep(1000);

    const evalJs = async (expr) => {
      const r = await ws.send('Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true,
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || '脚本异常');
      return r.result.value;
    };

    // 1) 该坐标上是谁（列出**所有**命中元素，而不只是最上面那个）
    const hitAll = await evalJs(`
      (() => {
        const els = document.elementsFromPoint(${X}, ${Y}) || [];
        return els.map((el) => {
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          const cls = el.className && el.className.baseVal !== undefined
                      ? el.className.baseVal : String(el.className || '');
          return {
            tag: el.tagName,
            id: el.id || '',
            cls: cls.slice(0, 50),
            rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
            opacity: cs.opacity,
            bg: cs.backgroundColor,
            fill: cs.fill,
          };
        });
      })()
    `);
    console.log(`坐标 (${X}, ${Y}) 命中的所有元素（从上层到下层）：`);
    for (const h of hitAll) {
      console.log(`  ${h.tag.padEnd(6)} #${String(h.id).padEnd(14)} ${String(h.cls).padEnd(34)} ` +
        `[${h.rect.join(',')}] op=${h.opacity} fill=${h.fill}`);
    }

    // 2) 用同一坐标的 SVG 命中测试：看立绘 SVG 内是否有元素覆盖此处
    const svgHit = await evalJs(`
      (() => {
        const out = [];
        document.querySelectorAll('#mascot-layer svg').forEach((svg) => {
          const r = svg.getBoundingClientRect();
          const inside = ${X} >= r.left && ${X} <= r.right
                      && ${Y} >= r.top && ${Y} <= r.bottom;
          if (!inside) return;
          const cs = getComputedStyle(svg);
          const cls = svg.className && svg.className.baseVal !== undefined
                      ? svg.className.baseVal : String(svg.className || '');
          out.push({
            cls,
            rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
            opacity: cs.opacity,
            overflow: cs.overflow,
          });
        });
        return out;
      })()
    `);
    console.log('\n覆盖该坐标的立绘 SVG：');
    for (const s of svgHit) {
      console.log(`  ${String(s.cls).padEnd(50)} [${s.rect.join(',')}] op=${s.opacity}`);
    }
    if (!svgHit.length) console.log('  （无）—— 该点的图形不是立绘画的');

    const hit = await evalJs(`
      (() => {
        const el = document.elementFromPoint(${X}, ${Y});
        if (!el) return { none: true };
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          id: el.id || '',
          cls: el.className && el.className.baseVal !== undefined
                ? el.className.baseVal : String(el.className || ''),
          rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
          opacity: cs.opacity,
          fill: cs.fill,
        };
      })()
    `);
    console.log(`\n坐标 (${X}, ${Y}) 最上层元素：`);
    console.log(JSON.stringify(hit));

    // 2) 立绘区域所有可见图层
    const layers = await evalJs(`
      (() => {
        const out = [];
        const root = document.querySelector('#mascot-layer');
        if (!root) return out;
        root.querySelectorAll('*').forEach((el) => {
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) return;
          if (cs.display === 'none' || cs.visibility === 'hidden') return;
          if (Number(cs.opacity) < 0.01) return;
          const cls = el.className && el.className.baseVal !== undefined
                      ? el.className.baseVal : String(el.className || '');
          out.push({
            tag: el.tagName,
            cls: cls.slice(0, 60),
            rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
            opacity: cs.opacity,
          });
        });
        return out;
      })()
    `);
    console.log('\n立绘区域内可见的图层：');
    for (const l of layers) {
      console.log(`  ${l.tag.padEnd(6)} ${String(l.cls).padEnd(44)} ` +
        `[${l.rect.join(',')}] op=${l.opacity}`);
    }

    // 3) 脉冲层为什么可见 —— 逐层看计算样式与命中规则
    const pulse = await evalJs(`
      (() => {
        const pick = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return { sel, missing: true };
          const cs = getComputedStyle(el);
          return {
            sel,
            opacity: cs.opacity,
            animationName: cs.animationName,
            animationPlayState: cs.animationPlayState,
            visibility: cs.visibility,
            display: cs.display,
            inlineOpacity: el.style.opacity || '(无)',
          };
        };
        const root = document.querySelector('.fairy-mascot-root');
        return {
          rootState: root ? root.dataset.state : '(无 root)',
          rootAttrs: root ? Array.from(root.attributes).map(a => a.name + '=' + a.value) : [],
          wave: pick('.fairy-mascot-lash-pulse-wave'),
          pulse: pick('.fairy-mascot-lash-pulse'),
          layer: pick('.fairy-mascot-pulse-layer'),
        };
      })()
    `);
    console.log('\n脉冲层的计算样式：');
    console.log(JSON.stringify(pulse, null, 2));
  } catch (err) {
    console.error(`✗ 诊断失败：${err.message}`);
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
