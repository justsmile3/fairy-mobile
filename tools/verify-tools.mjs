#!/usr/bin/env node
/**
 * verify-tools.mjs —— 验证工具调用链
 *
 * 覆盖三层：
 *   1. 纯函数（路径校验、工具定义）—— 不起浏览器，直接跑
 *   2. 工具循环（模拟 streamChat）—— 验证多轮、上限、失败回传
 *   3. 浏览器内的集成 —— 验证工具确实被注册、执行、结果回传
 *
 * 为什么值得单独一个脚本：
 *   工具调用的错误往往很隐蔽 —— 参数分片拼接、消息顺序、
 *   失败时模型是否会编造结果。这些用肉眼审代码很难确认。
 *
 * 用法：node tools/verify-tools.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'www', 'index.html');
const PORT = 9961 + (process.pid % 50);

const BROWSERS = [
  process.env.FAIRY_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean);

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}${detail ? `  — ${detail}` : ''}`); }
  else { fail += 1; failures.push(name); console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 第一层：纯函数 ───────────────────────────────────── */

async function testPure() {
  console.log('\n【一】工具定义与路径校验');

  const tools = await import(pathToFileURL(path.join(ROOT, 'js', 'tools.js')).href);

  const names = tools.TOOL_DEFINITIONS.map((t) => t.function.name);
  ok('工具定义非空', names.length >= 6, `${names.length} 个：${names.join(', ')}`);

  // 每个定义都必须有 name / description / parameters，否则 API 会报错
  const malformed = tools.TOOL_DEFINITIONS.filter((t) => {
    const f = t.function;
    return t.type !== 'function' || !f?.name || !f?.description
      || f?.parameters?.type !== 'object';
  });
  ok('工具定义格式合法（OpenAI function 格式）', malformed.length === 0,
    malformed.length ? malformed.map((t) => t.function?.name).join(',') : '');

  // 路径校验：这是安全边界，必须挡住穿越
  const cases = [
    ['notes/todo.md', true, '普通相对路径'],
    ['a/b/c.txt', true, '多级路径'],
    ['../secret.txt', false, '上跳越界'],
    ['notes/../../etc/passwd', false, '多级上跳'],
    ['/etc/passwd', false, '绝对路径'],
    ['C:\\Windows\\system32', false, '盘符路径'],
    ['notes/./a.txt', true, '含 . 的路径'],
    ['notes//a.txt', true, '重复斜杠'],
    ['bad<name>.txt', false, '非法字符'],
    ['', true, '空路径（根目录）'],
  ];
  let pathOk = 0;
  for (const [input, shouldPass, label] of cases) {
    const r = tools.sanitizePath(input);
    if (r.ok === shouldPass) pathOk += 1;
    else console.log(`      · 不符预期：${label} (${JSON.stringify(input)}) → ${JSON.stringify(r)}`);
  }
  ok('路径校验挡住越界与非法输入', pathOk === cases.length, `${pathOk}/${cases.length}`);

  // 结果格式化：失败必须能被模型看到
  const f1 = tools.formatToolResult('read_file', { ok: true, text: 'hello' });
  const f2 = tools.formatToolResult('read_file', { ok: false, error: '文件不存在' });
  ok('成功结果原样传递', f1 === 'hello');
  ok('失败结果带原因（模型能看到）', f2.includes('文件不存在'), f2);
}

/* ── 第二层：工具循环 ─────────────────────────────────── */

async function testLoop() {
  console.log('\n【二】工具调用循环');

  const agent = await import(pathToFileURL(path.join(ROOT, 'js', 'agent.js')).href);

  // 用一个假的 streamChat 驱动循环，观察它如何拼接消息
  function makeFakeStream(script) {
    let call = 0;
    const seen = [];
    const fn = async (params) => {
      seen.push(params);
      const step = script[call] || { content: '结束', toolCalls: [] };
      call += 1;
      return { content: step.content, toolCalls: step.toolCalls };
    };
    fn.calls = () => seen;
    return fn;
  }

  const runner = {
    hasNative: () => true,
    run: async (name, args) => ({ ok: true, text: `结果:${name}` }),
  };

  // 场景 A：一轮工具调用后就给出答案
  {
    const stream = makeFakeStream([
      { content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'device_info', arguments: '{"fields":["battery"]}' } }] },
      { content: '电量是 80%。', toolCalls: [] },
    ]);
    const r = await agent.runWithTools({
      params: { apiKey: 'k' }, messages: [{ role: 'user', content: '电量多少' }],
      runner, handlers: {},
    }, stream);
    ok('调用工具后能继续生成最终答复',
      r.content.includes('80%') && r.toolRounds === 1,
      `rounds=${r.toolRounds} content="${r.content}"`);

    // 关键：第二次请求必须带上 tool 结果，且顺序正确
    const second = stream.calls()[1];
    const roles = second.messages.map((m) => m.role);
    const hasAssistantToolCall = second.messages.some(
      (m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length);
    const hasToolResult = second.messages.some((m) => m.role === 'tool');
    ok('第二轮请求带上了 assistant.tool_calls', hasAssistantToolCall);
    ok('第二轮请求带上了 role=tool 的结果', hasToolResult,
      `消息角色序列：${roles.join(' → ')}`);
  }

  // 场景 B：工具返回失败，失败也必须回传（否则模型会编造）
  {
    const failRunner = {
      hasNative: () => true,
      run: async () => ({ ok: false, error: '路径越界' }),
    };
    const stream = makeFakeStream([
      { content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"../x"}' } }] },
      { content: '读不了。', toolCalls: [] },
    ]);
    await agent.runWithTools({
      params: {}, messages: [{ role: 'user', content: '读 ../x' }],
      runner: failRunner, handlers: {},
    }, stream);
    const second = stream.calls()[1];
    const toolMsg = second.messages.find((m) => m.role === 'tool');
    ok('工具失败也会回传给模型（不吞掉）',
      Boolean(toolMsg) && toolMsg.content.includes('路径越界'),
      toolMsg ? toolMsg.content.slice(0, 40) : '没有 tool 消息');
  }

  // 场景 C：参数不是合法 JSON —— 应回传解析错误，而不是崩溃
  {
    const stream = makeFakeStream([
      { content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{坏的' } }] },
      { content: '好的。', toolCalls: [] },
    ]);
    const r = await agent.runWithTools({
      params: {}, messages: [{ role: 'user', content: 'x' }],
      runner, handlers: {},
    }, stream);
    const toolMsg = stream.calls()[1].messages.find((m) => m.role === 'tool');
    ok('参数 JSON 损坏时回传错误而非崩溃',
      Boolean(toolMsg) && /JSON/.test(toolMsg.content) && r.toolRounds === 1);
  }

  // 场景 D：模型无限调用工具 —— 必须有轮数上限，否则请求风暴
  {
    let n = 0;
    const stream = async () => {
      n += 1;
      if (n > 20) return { content: 'stuck', toolCalls: [] };
      return {
        content: '',
        toolCalls: [{ id: `c${n}`, type: 'function', function: { name: 'device_info', arguments: '{}' } }],
      };
    };
    const r = await agent.runWithTools({
      params: {}, messages: [{ role: 'user', content: 'x' }],
      runner, handlers: {},
    }, stream);
    ok('有轮数上限，不会无限调用',
      r.stopped === 'max-rounds' && n <= 10,
      `stopped=${r.stopped} 请求次数=${n}`);
  }

  // 场景 E：没有原生桥时不注册工具
  {
    const stream = makeFakeStream([{ content: '直接回答。', toolCalls: [] }]);
    await agent.runWithTools({
      params: {}, messages: [{ role: 'user', content: 'x' }],
      runner: { hasNative: () => false, run: async () => ({ ok: true }) },
      handlers: {},
    }, stream);
    const first = stream.calls()[0];
    ok('无原生桥时不注册工具（避免无谓调用）', !first.tools);
  }
}

/* ── 第三层：浏览器集成 ───────────────────────────────── */

async function testInBrowser() {
  console.log('\n【三】浏览器集成（含原生桥桩）');

  const browser = BROWSERS.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (!browser) { ok('找到浏览器', false); return; }
  if (!fs.existsSync(ENTRY)) { ok('找到构建产物', false, '请先 build-apk'); return; }

  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-crashpad',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(os.tmpdir(), `fairy-tools-${Date.now()}`)}`,
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  let ws = null;
  try {
    const target = await waitForTarget();
    ws = await connect(target.webSocketDebuggerUrl);
    await ws.send('Runtime.enable');
    await ws.send('Page.enable');

    // 在页面加载前注入原生桥桩 —— 记录调用并返回可控结果
    await ws.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.__toolCalls = [];
        window.AndroidBridge = {
          isNative: () => '1',
          callTool: (name, argsJson) => {
            window.__toolCalls.push({ name, argsJson });
            if (name === 'device_info') {
              return JSON.stringify({ ok: true, data: { battery: { percent: 77 } } });
            }
            if (name === 'read_file') {
              return JSON.stringify({ ok: true, text: '文件内容示例' });
            }
            return JSON.stringify({ ok: false, error: '桩未实现' });
          },
          readStore: () => '',
          writeStore: () => '1',
        };
      `,
    });

    await ws.send('Page.navigate', { url: `file:///${ENTRY.replace(/\\/g, '/')}` });
    await waitForEval(ws, `!!window.__fairyTest`, 15000);

    const evalJs = async (expr) => {
      const r = await ws.send('Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true,
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || '脚本异常');
      return r.result.value;
    };

    // 设置界面里应有工具与记忆的开关/入口
    const ui = await evalJs(`
      (() => ({
        toolsToggle: !!document.querySelector('#set-tools-enabled'),
        memoryBox: !!document.querySelector('#memory-list') || !!document.querySelector('#btn-memory'),
      }))()
    `);
    ok('设置里有工具开关', ui.toolsToggle);
    ok('设置里有长期记忆入口', ui.memoryBox);

    // 通过测试钩子直接验证工具执行链
    const toolRun = await evalJs(`
      (async () => {
        if (!window.__fairyTest?.runTool) return { error: '缺少测试钩子 runTool' };
        const r = await window.__fairyTest.runTool('device_info', { fields: ['battery'] });
        return { r, calls: window.__toolCalls };
      })()
    `);
    if (toolRun.error) {
      ok('页面暴露工具执行钩子', false, toolRun.error);
    } else {
      ok('工具经原生桥执行并返回数据',
        JSON.stringify(toolRun.r).includes('77'),
        JSON.stringify(toolRun.r).slice(0, 70));
      ok('原生桥确实被调用', (toolRun.calls || []).length > 0,
        `调用 ${(toolRun.calls || []).length} 次`);
    }

    // 路径越界必须在 JS 侧就被挡住（不该透传到原生）
    const blocked = await evalJs(`
      (async () => {
        const before = (window.__toolCalls || []).length;
        const r = await window.__fairyTest.runTool('read_file', { path: '../../etc/passwd' });
        const after = (window.__toolCalls || []).length;
        return { r, bridged: after > before };
      })()
    `);
    ok('越界路径在 JS 侧被拒绝',
      blocked.r && blocked.r.ok === false,
      JSON.stringify(blocked.r).slice(0, 70));
    ok('越界请求不透传到原生层', blocked.bridged === false,
      blocked.bridged ? '仍然调用了原生桥' : '已拦截');

    // 记忆：写入后能读回
    const mem = await evalJs(`
      (async () => {
        if (!window.__fairyTest?.memory) return { error: '缺少记忆钩子' };
        const m = window.__fairyTest.memory;
        await m.add('主人喜欢简洁的回答');
        const found = m.search('简洁');
        const block = m.buildPromptBlock();
        return { count: m.count(), found: found.length, hasBlock: block.includes('简洁') };
      })()
    `);
    if (mem.error) {
      ok('页面暴露记忆钩子', false, mem.error);
    } else {
      ok('记忆能写入并检索到', mem.found >= 1, `共 ${mem.count} 条`);
      ok('记忆能生成注入区块', mem.hasBlock === true);
    }
  } catch (err) {
    ok('浏览器集成测试完成', false, err.message);
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

async function main() {
  await testPure();
  await testLoop();
  await testInBrowser();

  console.log('\n' + '─'.repeat(62));
  console.log(`通过 ${pass} / ${pass + fail}`);
  if (failures.length) {
    console.log('失败项：');
    for (const f of failures) console.log(`  · ${f}`);
  }
  if (fail) process.exitCode = 1;
}

main();
