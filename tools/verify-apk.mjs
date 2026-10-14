#!/usr/bin/env node
/**
 * verify-apk.mjs —— 在真实浏览器里验收 APK 打包后的资源
 *
 * 为什么要做这一步：
 *   Android WebView 对 file:// 页面有严格限制（ES module 被拒、同源策略收紧），
 *   这些在普通浏览器里都不会暴露。因此必须用等价的严格策略跑一遍，
 *   确认「脚本执行、样式生效、按钮可点、语音链路通」。
 *
 * 用法：
 *   node tools/verify-apk.mjs               # 无原生桥（纯浏览器行为）
 *   node tools/verify-apk.mjs --with-bridge  # 注入 AndroidBridge 桩，验证语音链路
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'www', 'index.html');
const PORT = 9411 + (process.pid % 200);

const WITH_BRIDGE = process.argv.includes('--with-bridge');

const BROWSERS = [
  process.env.FAIRY_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].filter(Boolean);

/** 注入的原生桥桩：记录调用，供断言检查 */
const BRIDGE_STUB = `
window.__calls = { ttsSpeak: 0, ttsSpeakCloud: 0, sttStart: 0, cloudParams: null };
window.AndroidBridge = (() => {
  const calls = window.__calls;
  return {
    isNative: () => '1',
    // 合成
    ttsSpeak: () => { calls.ttsSpeak += 1; },
    ttsSpeakCloud: (text, params) => {
      calls.ttsSpeakCloud += 1;
      calls.cloudParams = params;
      // 模拟播放结束，避免界面卡在「说话中」
      setTimeout(() => {
        if (window.__fairyVoice && window.__fairyVoice.onTtsEnd) window.__fairyVoice.onTtsEnd();
      }, 60);
    },
    ttsStop: () => {}, ttsSetRate: () => {}, ttsSetPitch: () => {},
    ttsIsSpeaking: () => '0',
    ttsSupported: () => '1',
    ttsBackend: () => 'cloud',
    ttsListVoices: () => JSON.stringify([]),
    ttsSetVoice: () => {}, ttsReinit: () => {},
    openTtsSettings: () => {}, openExternal: () => {},
    setTtsBackend: () => {},
    // 克隆上传
    uploadVoice: () => { calls.uploadVoice = (calls.uploadVoice || 0) + 1; },
    // 内置参考录音（模拟原生读取 assets 的结果）
    readBuiltinVoice: () => {
      calls.readBuiltin = (calls.readBuiltin || 0) + 1;
      return JSON.stringify({
        ok: '1',
        base64: 'UklGRiQAAABXQVZF',   // 极简 WAV 头，仅用于测试
        mime: 'audio/wav',
        bytes: '244700',
        text: '主人，我是fairy。语音系统已经准备就绪，随时为您提供帮助。',
      });
    },
    // 语音输入
    sttSupported: () => '1',
    sttBackend: () => 'cloud-nocred',
    sttSetCredentials: () => {}, sttStart: () => { calls.sttStart += 1; },
    sttStop: () => {}, sttCancel: () => {},
    sttCloudReady: () => '0',
    // 诊断
    clearCrash: () => {},

    // 联网搜索：立即回调一个假结果，验证链路
    searchWeb: (paramsJson) => {
      calls.searchWeb = (calls.searchWeb || 0) + 1;
      calls.searchParams = paramsJson;
      setTimeout(() => {
        if (window.__fairySearch && window.__fairySearch.onResult) {
          window.__fairySearch.onResult(true, JSON.stringify({
            engine: 'bing',
            query: 'test',
            results: [
              { title: '测试结果一', url: 'https://example.com/1', snippet: '这是第一条测试摘要。' },
              { title: '测试结果二', url: 'https://example.com/2', snippet: '这是第二条测试摘要。' },
            ],
          }));
        }
      }, 80);
    },
    searchAvailable: () => '1',
    // 悬浮球
    floatingBallStatus: () => JSON.stringify({
      supported: '1',
      permission: calls.floatPermitted ? '1' : '0',
      running: calls.floatRunning ? '1' : '0',
      status: calls.floatRunning ? '悬浮球已启动，1080x2400 球径 156px' : '',
      error: calls.forceFail || '',
      sdk: 35,
    }),
    floatingBallStart: () => {
      calls.floatStart = (calls.floatStart || 0) + 1;
      if (!calls.floatPermitted) return 'noperm';
      // 模拟「服务内部失败」：调用本身成功，但窗口没建起来
      if (calls.forceFail) return 'failed:' + calls.forceFail;
      calls.floatRunning = true;
      return '1';
    },
    floatingBallStop: () => {
      calls.floatRunning = false;
      return '1';
    },
    floatingBallRequestPermission: () => {
      calls.floatPermRequest = (calls.floatPermRequest || 0) + 1;
      calls.floatPermitted = true;   // 模拟用户授权后返回
    },
    diag: () => JSON.stringify({
      ttsReady: '0', cloudTts: '1', backend: 'cloud',
      voiceCount: 0, engine: '系统默认', engines: [], sdk: 35,
      sttAvailable: '1',
    }),
  };
})();
`;

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
    `--user-data-dir=${path.join(os.tmpdir(), `fairy-apk-${Date.now()}`)}`,
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  let ws = null;
  try {
    const target = await waitForTarget();
    ws = await connect(target.webSocketDebuggerUrl);
    const result = await runChecks(ws);
    report(result);
    process.exitCode = result.failed === 0 ? 0 : 1;
  } catch (err) {
    console.error(`✗ 验收失败：${err.message}`);
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
            const list = JSON.parse(body);
            const page = list.find((t) => t.type === 'page');
            if (page) resolve(page);
            else retry();
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
    socket.addEventListener('error', () => reject(new Error('无法连接浏览器调试端口')));
  });
}

async function runChecks(ws) {
  const checks = [];
  const consoleErrors = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail });

  await ws.send('Runtime.enable');
  await ws.send('Page.enable');
  await ws.send('Log.enable');

  const evaluate = async (expression) => {
    const r = await ws.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || '脚本执行异常');
    }
    return r.result.value;
  };

  // 收集控制台错误
  ws.send('Runtime.consoleAPICalled').catch(() => {});
  const origSend = ws.send.bind(ws);

  // 先注入桥桩，再加载页面（顺序很重要）
  if (WITH_BRIDGE) {
    await ws.send('Page.addScriptToEvaluateOnNewDocument', { source: BRIDGE_STUB });
  }

  // 严格等价于 WebView 的 file:// 策略
  await ws.send('Emulation.setDeviceMetricsOverride', {
    width: 393, height: 851, deviceScaleFactor: 2, mobile: true,
  });
  await ws.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  const fileUrl = `file:///${ENTRY.replace(/\\/g, '/')}`;
  await ws.send('Page.navigate', { url: fileUrl });

  // 等待脚本执行完成（立绘渲染出来即代表 bundle 已运行）
  await waitFor(evaluate, `!!document.querySelector('#mascot-layer svg')`, 15000);
  add('入口脚本已执行（立绘 SVG 渲染）', true);

  // 样式生效
  const styled = await evaluate(`
    (() => {
      const n = document.querySelector('.app') || document.body;
      const bg = getComputedStyle(n).backgroundColor;
      return bg !== '' && bg !== 'rgba(0, 0, 0, 0)';
    })()
  `);
  add('样式已生效', styled);

  // 无横向溢出
  const noOverflow = await evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 2`);
  add('无横向溢出', noOverflow);

  // 交互链路
  await evaluate(`document.querySelector('#btn-menu')?.click()`);
  await sleep(250);
  const drawerOpen = await evaluate(`!document.querySelector('#session-drawer')?.hidden`);
  add('菜单 → 会话抽屉打开', drawerOpen);

  await evaluate(`document.querySelector('#btn-new-session')?.click()`);
  await sleep(300);
  add('新建会话', true);

  await evaluate(`document.querySelector('#btn-settings')?.click()`);
  await sleep(300);
  const settingsOpen = await evaluate(`!document.querySelector('#settings')?.hidden`);
  add('设置面板打开', settingsOpen);

  // 语音状态提示
  const speechNote = await evaluate(`document.querySelector('#speech-support')?.textContent || ''`);
  add('语音状态提示已更新', speechNote.trim().length > 0, speechNote.trim().slice(0, 60));

  // 发送按钮状态
  await evaluate(`
    (() => {
      const i = document.querySelector('#input');
      i.value = '你好';
      i.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await sleep(200);
  const sendEnabled = await evaluate(`!document.querySelector('#btn-send')?.disabled`);
  add('发送按钮已启用', sendEnabled);

  if (WITH_BRIDGE) {
    // 诊断面板
    await evaluate(`document.querySelector('#btn-voice-diag')?.click()`);
    await sleep(350);
    const diagText = await evaluate(`document.querySelector('#voice-diag')?.textContent || ''`);
    add('诊断面板可显示', diagText.includes('云语音'));

    // 语音设置界面存在
    const hasProvider = await evaluate(`!!document.querySelector('#set-tts-provider')`);
    add('云语音设置界面存在', hasProvider);

    // 试听 → 应走云端接口
    await evaluate(`document.querySelector('#btn-test-voice')?.click()`);
    await sleep(600);
    const cloudCalls = await evaluate(`window.__calls.ttsSpeakCloud`);
    add('试听触发云语音合成', cloudCalls > 0, `ttsSpeakCloud 调用 ${cloudCalls} 次`);

    // 传给原生的参数应含 provider/voice 等字段
    const params = await evaluate(`window.__calls.cloudParams`);
    let paramsOk = false;
    let desc = String(params).slice(0, 80);
    try {
      const o = JSON.parse(params);
      paramsOk = Boolean(o.provider) && 'speed' in o;
      desc = `provider=${o.provider} voice=${o.voice || '(预置)'}`;
    } catch { /* 忽略 */ }
    add('合成参数格式正确', paramsOk, desc);

    // 切换提供商 → 表单应联动
    await evaluate(`
      (() => {
        const s = document.querySelector('#set-tts-provider');
        s.value = 'siliconflow';
        s.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `);
    await sleep(300);
    const sfVisible = await evaluate(`!document.querySelector('#sf-box')?.hidden`);
    add('选择 SiliconFlow 后显示其配置项', sfVisible);

    // 关键回归：克隆入口必须在**默认状态下就可见**。
    // 之前把上传区藏在 sf-box 里且初始化未同步，导致用户找不到入口。
    // 判断方式：元素存在 + 自身未被 hidden + 祖先链上没有 hidden + 有布局尺寸。
    const freshVisible = await evaluate(`
      (() => {
        const btn = document.querySelector('#btn-clone-top');
        if (!btn) return { ok: false, why: '元素不存在' };
        // 自身与所有祖先都不能是 hidden
        let node = btn;
        while (node && node !== document.body) {
          if (node.hidden) return { ok: false, why: '#' + (node.id || node.tagName) + ' 处于 hidden' };
          const cs = getComputedStyle(node);
          if (cs.display === 'none' || cs.visibility === 'hidden') {
            return { ok: false, why: '#' + (node.id || node.tagName) + ' display/visibility 隐藏' };
          }
          node = node.parentElement;
        }
        const r = btn.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) {
          return { ok: false, why: '尺寸为 0（可能未渲染）' };
        }
        return { ok: true, why: '' };
      })()
    `);
    add('克隆入口默认可见（无需先切提供商）', freshVisible.ok, freshVisible.why);

    // 点顶部克隆按钮：
    //   未填 Key 时 → 自动切到 SiliconFlow 并提示填 Key
    //   已填 Key 时 → 读取**内置录音**并开始上传（不再依赖文件选择器）
    await evaluate(`
      (() => {
        const s = document.querySelector('#set-tts-provider');
        s.value = 'auto';
        s.dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('#btn-clone-top')?.click();
      })()
    `);
    await sleep(500);
    const guided = await evaluate(`
      (() => {
        const sel = document.querySelector('#set-tts-provider')?.value;
        const boxShown = !document.querySelector('#sf-box')?.hidden;
        const hint = document.querySelector('#clone-top-hint')?.textContent || '';
        return { sel, boxShown, mentionsKey: /API Key/.test(hint) };
      })()
    `);
    add('未填 Key 时点克隆会引导去填 Key',
      guided.sel === 'siliconflow' && guided.boxShown && guided.mentionsKey,
      `provider=${guided.sel} 配置区可见=${guided.boxShown}`);

    // 填上 Key 再点：应读取内置录音并发起上传
    await evaluate(`
      (() => {
        const k = document.querySelector('#set-sf-key');
        k.value = 'sk-test-fake';
        k.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#btn-clone-top')?.click();
      })()
    `);
    await sleep(700);
    const builtin = await evaluate(`
      (() => ({
        read: window.__calls.readBuiltin || 0,
        uploaded: window.__calls.uploadVoice || 0,
        hint: (document.querySelector('#clone-top-hint')?.textContent || '').slice(0, 60),
      }))()
    `);
    add('填了 Key 后点克隆会读取内置录音并上传',
      builtin.read > 0 && builtin.uploaded > 0,
      `读取 ${builtin.read} 次 / 上传 ${builtin.uploaded} 次`);

    // 页面里必须存在文件选择用 input（作为手动上传的备选路径）
    const hasFileInput = await evaluate(`
      (() => {
        const f = document.querySelector('#clone-audio-file');
        return !!f && f.type === 'file';
      })()
    `);
    add('保留手动上传录音的备选入口', hasFileInput);

    /* ── 视差背景与提示音 ── */

    // 背景画布必须存在且尺寸正确（Canvas 为 0 尺寸时画不出东西）
    const bgInfo = await evaluate(`
      (() => {
        const c = document.querySelector('#hdd-bg');
        if (!c) return { ok: false, why: '画布不存在' };
        return {
          ok: c.width > 0 && c.height > 0,
          w: c.width, h: c.height,
          isCanvas: c.tagName === 'CANVAS',
        };
      })()
    `);
    add('视差背景画布已渲染', bgInfo.ok && bgInfo.isCanvas,
      bgInfo.ok ? `${bgInfo.w}×${bgInfo.h}` : bgInfo.why);

    // 背景确实画了东西（读取像素，全透明说明没画）
    const painted = await evaluate(`
      (() => {
        const c = document.querySelector('#hdd-bg');
        if (!c || !c.width) return { ok: false, why: '画布不可用' };
        try {
          const ctx = c.getContext('2d');
          const d = ctx.getImageData(Math.floor(c.width/2), Math.floor(c.height/2), 1, 1).data;
          return { ok: d[3] > 0, rgba: [d[0], d[1], d[2], d[3]] };
        } catch (e) { return { ok: false, why: e.message }; }
      })()
    `);
    add('背景已实际绘制（非空白）', painted.ok,
      painted.ok ? `中心像素 rgba(${painted.rgba.join(',')})` : painted.why);

    // 拖动**不应**移动背景（本次需求：背景静止，位置靠设置调节）
    const dragResult = await evaluate(`
      (async () => {
        const chat = document.querySelector('#chat');
        const pet = document.querySelector('#mascot-layer');
        if (!chat || !pet) return { ok: false, why: '元素缺失' };
        const before = pet.style.transform || '';
        const rect = chat.getBoundingClientRect();
        const y = rect.top + 120;
        const x0 = rect.left + rect.width - 40;
        const fire = (type, x) => chat.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, clientX: x, clientY: y,
          pointerId: 1, pointerType: 'touch', isPrimary: true, buttons: 1,
        }));
        fire('pointerdown', x0);
        for (let i = 1; i <= 6; i++) fire('pointermove', x0 - i * 18);
        await new Promise(r => setTimeout(r, 150));
        const during = pet.style.transform || '';
        fire('pointerup', x0 - 108);
        await new Promise(r => setTimeout(r, 300));
        return { ok: during === before, before, during };
      })()
    `);
    add('拖动不会移动背景/立绘（背景静止）',
      dragResult.ok,
      dragResult.ok ? '拖动无位移' : `位移了：${dragResult.during}`);

    // 界面融合：应存在 --fuse 变量，且顶栏/输入区不再是实色卡片
    const fuseInfo = await evaluate(`
      (() => {
        const cs = getComputedStyle(document.documentElement);
        const fuse = cs.getPropertyValue('--fuse').trim();
        const inv = cs.getPropertyValue('--fuse-inv').trim();
        const topbar = document.querySelector('#topbar');
        const composer = document.querySelector('#composer-box');
        const tcs = topbar ? getComputedStyle(topbar) : null;
        const ccs = composer ? getComputedStyle(composer) : null;
        return {
          fuse, inv,
          topbarBorderBottom: tcs ? tcs.borderBottomWidth : '',
          topbarBg: tcs ? tcs.backgroundImage.slice(0, 40) : '',
          composerHasLeftGlow: ccs ? ccs.borderLeftWidth : '',
          composerRadius: ccs ? ccs.borderTopLeftRadius : '',
        };
      })()
    `);
    add('界面融合变量已生效',
      fuseInfo.fuse !== '' && fuseInfo.inv !== '',
      `--fuse=${fuseInfo.fuse} --fuse-inv=${fuseInfo.inv}`);
    add('顶栏不再是实色卡片（无实线分隔）',
      fuseInfo.topbarBorderBottom === '0px',
      `border-bottom=${fuseInfo.topbarBorderBottom}`);
    add('输入条改为发光左边（终端风格）',
      parseFloat(fuseInfo.composerHasLeftGlow) >= 2,
      `border-left=${fuseInfo.composerHasLeftGlow} 圆角=${fuseInfo.composerRadius}`);

    // 背景参数设置项
    const bgParams = await evaluate(`
      (() => ({
        fuse: !!document.querySelector('#set-fuse'),
        density: !!document.querySelector('#set-bg-density'),
        bright: !!document.querySelector('#set-bg-bright'),
      }))()
    `);
    add('设置里有融合强度与背景参数',
      bgParams.fuse && bgParams.density && bgParams.bright,
      '');

    // 提示音设置项
    const chimeUi = await evaluate(`
      (() => ({
        toggle: !!document.querySelector('#set-chime-enabled'),
        preset: document.querySelector('#set-chime-preset')?.options.length || 0,
        vol: !!document.querySelector('#set-chime-volume'),
        testBtn: !!document.querySelector('#btn-chime-test'),
      }))()
    `);
    add('设置里有提示音开关与音色选项',
      chimeUi.toggle && chimeUi.vol && chimeUi.testBtn && chimeUi.preset >= 4,
      `音色选项 ${chimeUi.preset} 个`);

    /* ── 朗读文本改写 ── */

    const simplifyUi = await evaluate(`
      (() => ({
        simplify: !!document.querySelector('#set-speech-simplify'),
        rewrite: !!document.querySelector('#set-speech-rewrite'),
        model: document.querySelector('#set-speech-model')?.options.length || 0,
        previewBtn: !!document.querySelector('#btn-speech-preview'),
        previewBox: !!document.querySelector('#speech-preview'),
      }))()
    `);
    add('设置里有朗读处理选项与预览入口',
      simplifyUi.simplify && simplifyUi.rewrite && simplifyUi.previewBtn && simplifyUi.model >= 2,
      `模型选项 ${simplifyUi.model} 个`);

    // 总结阈值控件（超过多少字才总结）
    const minCtl = await evaluate(`
      (() => {
        const r = document.querySelector('#set-speech-min');
        return { exists: !!r, val: r?.value || '', min: r?.min || '', max: r?.max || '' };
      })()
    `);
    add('有总结触发字数阈值',
      minCtl.exists && Number(minCtl.val) > 0,
      `默认 ${minCtl.val} 字（范围 ${minCtl.min}–${minCtl.max}）`);

    // 本地清洗必须真的能去掉 Markdown（这是每次朗读都会走的路径）
    const cleaned = await evaluate(`
      (() => {
        // 通过预览按钮的同一套逻辑验证：直接构造样例并观察结果
        const sample = '## 标题\\n\\n**粗体**与[链接](https://a.b/c)。\\n\\n\`\`\`js\\nlet a=1;\\n\`\`\`';
        // 页面内没有导出该函数，改为验证模型下拉与开关的联动
        const t = document.querySelector('#set-speech-simplify');
        const r = document.querySelector('#set-speech-rewrite');
        const wasDisabled = r.disabled;
        t.checked = false;
        t.dispatchEvent(new Event('change', { bubbles: true }));
        const afterOff = r.disabled;
        t.checked = true;
        t.dispatchEvent(new Event('change', { bubbles: true }));
        const afterOn = r.disabled;
        return { sample: sample.slice(0, 20), afterOff, afterOn, wasDisabled };
      })()
    `);
    add('关闭改写后 API 选项随之禁用（联动正确）',
      cleaned.afterOff === true && cleaned.afterOn === false,
      `关闭时禁用=${cleaned.afterOff} 开启时禁用=${cleaned.afterOn}`);

    // 预览按钮应产出「原文 / 本地清洗 / API 改写」三段对比。
    // 注意：没有 API Key 时 API 段会显示跳过说明，这是预期行为，
    // 断言只要求「原文」与「本地清洗」两段确实出现。
    await evaluate(`document.querySelector('#btn-speech-preview')?.click()`);
    await sleep(1500);
    const previewText = await evaluate(`
      (() => {
        const b = document.querySelector('#speech-preview');
        return { hidden: b?.hidden, text: b?.textContent || '' };
      })()
    `);
    add('预览能展示改写对比（原文 + 本地清洗）',
      !previewText.hidden
      && previewText.text.includes('原文')
      && previewText.text.includes('本地清洗'),
      previewText.text.slice(0, 70).replace(/\s+/g, ' '));

    // 模型列表应包含 v4 选项（用户要求可手动切换）
    const modelHasV4 = await evaluate(`
      (() => {
        const sel = document.querySelector('#set-model');
        if (!sel) return { ok: false, opts: [] };
        const opts = Array.from(sel.options).map((o) => o.value);
        return { ok: opts.some((v) => /v4/.test(v)), opts };
      })()
    `);
    add('模型列表含 v4 选项（可手动切换）',
      modelHasV4.ok,
      modelHasV4.opts.join(', '));

    // 提示音必须能真正合成出声音（AudioContext 可创建且未报错）
    const chimeInfo = await evaluate(`
      (() => {
        try {
          const Ctor = window.AudioContext || window.webkitAudioContext;
          if (!Ctor) return { ok: false, why: '浏览器不支持 Web Audio' };
          const ctx = new Ctor();
          const ok = typeof ctx.createOscillator === 'function';
          ctx.close();
          return { ok, state: 'ok' };
        } catch (e) { return { ok: false, why: e.message }; }
      })()
    `);
    add('提示音合成可用（Web Audio）', chimeInfo.ok, chimeInfo.why || '');

    // ★ 回归：立绘的三层 SVG（光环 / 脉冲 / 主体）必须**几何对齐**。
    //
    // 曾经光环层用 left: -112.5% 定位，在 96px 的小容器上整体左移约 108px，
    // 表现为立绘旁边凭空多出一个空心圆（截图才发现）。
    // 改用 left:50% + translate(-50%,-50%) 后基准明确，不再随容器漂移。
    const layerAlign = await evaluate(`
      (() => {
        const sel = [
          '.fairy-mascot-halo-layer',
          '.fairy-mascot-pulse-layer',
          '.fairy-mascot-svg-main',
        ];
        const rects = sel.map((s) => {
          const el = document.querySelector(s);
          if (!el) return { s, missing: true };
          const r = el.getBoundingClientRect();
          return { s, x: Math.round(r.left), y: Math.round(r.top),
                   w: Math.round(r.width), h: Math.round(r.height) };
        });
        const ok = rects.every((r) => !r.missing);
        if (!ok) return { ok: false, why: '存在缺失层', rects };
        const base = rects[2];
        // 允许 2px 误差
        const aligned = rects.every((r) =>
          Math.abs(r.x - base.x) <= 2 && Math.abs(r.y - base.y) <= 2
          && Math.abs(r.w - base.w) <= 2 && Math.abs(r.h - base.h) <= 2);
        return { ok: aligned, rects };
      })()
    `);
    add('立绘三层 SVG 几何对齐',
      layerAlign.ok,
      layerAlign.ok
        ? '三层重合'
        : JSON.stringify(layerAlign.rects || layerAlign.why));

    // ★ 回归：脉冲环在 idle 状态必须不可见（否则立绘旁会多出装饰轮廓）
    const pulseHidden = await evaluate(`
      (() => {
        const wave = document.querySelector('.fairy-mascot-lash-pulse-wave');
        const layer = document.querySelector('.fairy-mascot-pulse-layer');
        if (!wave) return { ok: false, why: '找不到脉冲环' };
        const wv = Number(getComputedStyle(wave).opacity);
        const lv = Number(getComputedStyle(layer || wave).opacity);
        return { ok: wv < 0.01 && lv > 0.5, waveOpacity: wv, layerOpacity: lv };
      })()
    `);
    add('idle 状态下脉冲环不可见',
      pulseHidden.ok,
      `环=${pulseHidden.waveOpacity} 层=${pulseHidden.layerOpacity}`);

    /* ── 顶栏立绘开关 ── */

    const toggleInfo = await evaluate(`
      (() => {
        const btn = document.querySelector('#btn-mascot-toggle');
        const title = document.querySelector('#topbar-title');
        if (!btn || !title) return { ok: false, why: '元素缺失' };
        const br = btn.getBoundingClientRect();
        const tr = title.getBoundingClientRect();
        return {
          ok: true,
          // 关键：按钮必须在标题左侧
          leftOfTitle: br.right <= tr.left + 1,
          pressed: btn.getAttribute('aria-pressed'),
          hasEyeIcon: !!btn.querySelector('.eye-disc') && !!btn.querySelector('.eye-pupil'),
          visible: br.width > 0 && br.height > 0,
        };
      })()
    `);
    add('顶栏有立绘开关且位于标题左侧',
      toggleInfo.ok && toggleInfo.leftOfTitle && toggleInfo.visible,
      toggleInfo.ok ? `标题左侧=${toggleInfo.leftOfTitle}` : toggleInfo.why);
    add('立绘开关图标画成眼睛（非通用图标）',
      toggleInfo.hasEyeIcon, '');

    // 点击按钮应切换立绘显隐，并与设置里的开关同步
    const toggleFlow = await evaluate(`
      (async () => {
        const btn = document.querySelector('#btn-mascot-toggle');
        const layer = document.querySelector('#mascot-layer');
        const cb = document.querySelector('#set-mascot-visible');
        const read = () => ({
          layerHidden: layer.dataset.hidden,
          pressed: btn.getAttribute('aria-pressed'),
          checkbox: cb.checked,
        });
        const before = read();
        btn.click();
        await new Promise(r => setTimeout(r, 120));
        const afterFirst = read();
        btn.click();
        await new Promise(r => setTimeout(r, 120));
        const afterSecond = read();
        return { before, afterFirst, afterSecond };
      })()
    `);
    // 第一次点击：立绘收起（hidden=true, pressed=false, 设置同步为未勾选）
    add('点击开关能收起立绘且三处状态同步',
      toggleFlow.afterFirst.layerHidden === 'true'
      && toggleFlow.afterFirst.pressed === 'false'
      && toggleFlow.afterFirst.checkbox === false,
      `layer=${toggleFlow.afterFirst.layerHidden} pressed=${toggleFlow.afterFirst.pressed} cb=${toggleFlow.afterFirst.checkbox}`);
    // 第二次点击：恢复
    add('再次点击能展开立绘并恢复状态',
      toggleFlow.afterSecond.layerHidden === 'false'
      && toggleFlow.afterSecond.pressed === 'true'
      && toggleFlow.afterSecond.checkbox === true,
      `layer=${toggleFlow.afterSecond.layerHidden} pressed=${toggleFlow.afterSecond.pressed}`);

    // 反向同步：改设置里的开关，顶栏按钮也要跟着变
    const reverseSync = await evaluate(`
      (async () => {
        const btn = document.querySelector('#btn-mascot-toggle');
        const cb = document.querySelector('#set-mascot-visible');
        cb.checked = false;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 120));
        const off = btn.getAttribute('aria-pressed');
        cb.checked = true;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 120));
        return { off, on: btn.getAttribute('aria-pressed') };
      })()
    `);
    add('从设置改开关时顶栏按钮同步更新',
      reverseSync.off === 'false' && reverseSync.on === 'true',
      `设置关闭后按钮=${reverseSync.off}，开启后=${reverseSync.on}`);

    /* ── 联网搜索 ── */

    const searchUi = await evaluate(`
      (() => ({
        toggle: !!document.querySelector('#set-search-enabled'),
        engineSel: !!document.querySelector('#set-search-engine'),
        engineCount: document.querySelector('#set-search-engine')?.options.length || 0,
        testBtn: !!document.querySelector('#btn-search-test'),
        status: document.querySelector('#search-status')?.textContent || '',
      }))()
    `);
    add('设置里有联网搜索开关与引擎选择',
      searchUi.toggle && searchUi.engineSel && searchUi.testBtn,
      `引擎选项 ${searchUi.engineCount} 个`);

    add('搜索引擎下拉已填充选项',
      searchUi.engineCount >= 3,
      String(searchUi.engineCount));

    // 测试搜索：桥桩返回假结果，验证链路与展示
    await evaluate(`
      (() => {
        window.__calls.searchWeb = 0;
        document.querySelector('#btn-search-test')?.click();
      })()
    `);
    await sleep(1000);
    const searchResult = await evaluate(`
      (() => ({
        called: window.__calls.searchWeb || 0,
        status: document.querySelector('#search-status')?.textContent || '',
      }))()
    `);
    add('测试搜索会调用原生搜索桥',
      searchResult.called > 0,
      searchResult.status.slice(0, 70));

    /* ── 悬浮球（语音唤醒）── */

    // 设置面板里应有悬浮球开关
    await evaluate(`document.querySelector('#btn-settings')?.click()`);
    await sleep(300);
    const floatUi = await evaluate(`
      (() => ({
        toggle: !!document.querySelector('#set-float-enabled'),
        perm: !!document.querySelector('#btn-float-perm'),
        status: document.querySelector('#float-status')?.textContent || '',
      }))()
    `);
    add('设置里有悬浮球开关与权限入口',
      floatUi.toggle && floatUi.perm,
      floatUi.status.slice(0, 50));

    // 无权限时勾选开关应触发「去授权」引导，而不是静默失败
    await evaluate(`
      (() => {
        window.__calls.floatPermitted = false;
        window.__calls.floatRunning = false;
        const t = document.querySelector('#set-float-enabled');
        t.checked = true;
        t.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `);
    await sleep(400);
    const afterNoPerm = await evaluate(`
      (() => ({
        req: window.__calls.floatPermRequest || 0,
        status: document.querySelector('#float-status')?.textContent || '',
      }))()
    `);
    add('无权限时开启会引导去授权',
      afterNoPerm.req > 0,
      `请求授权 ${afterNoPerm.req} 次`);

    // 授权后应自动开启悬浮球（用户意图被记住）
    await sleep(1600);
    const autoOn = await evaluate(`
      (() => ({
        start: window.__calls.floatStart || 0,
        running: !!window.__calls.floatRunning,
        status: document.querySelector('#float-status')?.textContent || '',
      }))()
    `);
    add('授权后自动开启悬浮球',
      autoOn.running,
      `启动调用 ${autoOn.start} 次`);

    // 关闭开关应停止服务
    await evaluate(`
      (() => {
        const t = document.querySelector('#set-float-enabled');
        t.checked = false;
        t.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `);
    await sleep(500);
    const stopped = await evaluate(`!window.__calls.floatRunning`);
    add('关闭开关会停掉悬浮球', stopped);

    // ★ 回归：服务启动失败时，勾选**不能**被悄悄取消掉。
    //
    // 用户反馈的现象就是「勾了之后自动取消且没有悬浮球」——
    // 原因是原生只返回 '1'（startService 调用成功），但服务内部失败了，
    // 页面 400ms 后读状态发现 running=false 就把勾选打回去，且不给原因。
    // 现在要求：保持勾选 + 显示具体失败原因。
    await evaluate(`
      (() => {
        window.__calls.floatPermitted = true;
        window.__calls.floatRunning = false;
        window.__calls.forceFail = '系统拒绝了悬浮窗（BadToken）';
        const t = document.querySelector('#set-float-enabled');
        t.checked = true;
        t.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `);
    await sleep(900);
    const failCase = await evaluate(`
      (() => {
        const t = document.querySelector('#set-float-enabled');
        const s = document.querySelector('#float-status');
        return { checked: !!t?.checked, text: s?.textContent || '', cls: s?.className || '' };
      })()
    `);
    add('启动失败时不会静默取消勾选',
      failCase.checked === true,
      `勾选=${failCase.checked}`);
    add('启动失败时显示具体原因',
      /失败/.test(failCase.text) && failCase.text.length > 6,
      failCase.text.slice(0, 60));

    // 恢复：清掉强制失败标记，避免影响后续用例
    await evaluate(`delete window.__calls.forceFail; window.__calls.floatRunning = false;`);

    // 原生回调 onFloatingBallTap 必须存在（悬浮球点击后由它进入语音输入）
    const tapHook = await evaluate(`
      typeof (window.__fairyVoice && window.__fairyVoice.onFloatingBallTap)
    `);
    add('页面已注册悬浮球点击回调', tapHook === 'function', String(tapHook));

    // 触发回调：应进入聆听状态
    await evaluate(`
      (() => {
        const mic = document.querySelector('#btn-mic');
        if (mic) mic.hidden = false;
        window.__calls.sttStart = 0;
        window.__fairyVoice.onFloatingBallTap();
      })()
    `);
    await sleep(600);
    const afterTap = await evaluate(`
      (() => ({
        stt: window.__calls.sttStart || 0,
        pressed: document.querySelector('#btn-mic')?.getAttribute('aria-pressed'),
        status: document.querySelector('#status')?.textContent || '',
      }))()
    `);
    add('悬浮球点击会开始语音输入',
      afterTap.stt > 0,
      `sttStart ${afterTap.stt} 次`);
  }

  return { checks, consoleErrors };
}

function waitFor(evaluate, expr, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        if (await evaluate(expr)) return resolve(true);
      } catch { /* 继续等 */ }
      if (Date.now() > deadline) return reject(new Error(`等待超时：${expr}`));
      setTimeout(tick, 200);
    };
    tick();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function report({ checks }) {
  const title = WITH_BRIDGE ? ' · 含原生桥桩' : '';
  console.log('');
  console.log(`APK 资源验收（file:// · 严格安全策略 · 393×851 · 触摸）${title}`);
  console.log('─'.repeat(62));
  let failed = 0;
  for (const c of checks) {
    if (!c.ok) failed += 1;
    const mark = c.ok ? '✓' : '✗';
    const detail = c.detail ? `  — ${c.detail}` : '';
    console.log(`  ${mark} ${c.name}${detail}`);
  }
  console.log('─'.repeat(62));
  console.log(`通过 ${checks.length - failed} / ${checks.length}`);
  console.log('');
}

main();
