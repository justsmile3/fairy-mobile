/**
 * main.js —— Fairy 应用主逻辑
 *
 * 入口模块。发布时经 tools/bundle.mjs 用 esbuild 打成单文件经典脚本
 * （js/bundle.js），再由 index.html 以普通 <script> 加载 —— 这样在
 * Android WebView 的 file:// 环境下也能正常运行（ES 模块在 file:// 下会被 CORS 拦截）。
 */

import {
  getSettings, patchSettings, listSessions, createSession, updateSession,
  deleteSession, listMessages, addMessage, updateMessage, deleteMessage,
  truncateAfter, exportAll, importAll, clearAll, estimateUsage, DEFAULT_MODELS,
  DEFAULT_SETTINGS,
} from './store.js';
import {
  streamChat, listModels, getBalance, buildRequestMessages, ApiError,
  normalizeBaseUrl,
} from './api.js';
import { buildSystemPrompt, titleFromText } from './persona.js';
import { renderMarkdown, escapeHtml } from './markdown.js';
import { $, $$, el, toast, confirmDialog, copyText, formatTime, rafThrottle, debounce } from './ui.js';
import { createMascot } from './mascot.js';
import * as speechModule from './speech.js';
import {
  PROVIDERS, getProvider, resolveProvider, buildSynthesisParams,
  validateConfig, cloneVoiceFromAudio,
} from './cloudtts.js';
import { initCloudTtsUi } from './cloudtts-ui.js';
import { initFloatingBall } from './floating-ball.js';
import {
  shouldSearch, buildQuery, search, formatForPrompt, injectSearchContext,
} from './search.js';
import { initSearchUi } from './search-ui.js';
import { createHddBackground } from './hdd-bg.js';
import { createChime, CHIME_PRESETS } from './chime.js';

const BUILD_VERSION = '0.1.0';

/* ── 全局状态 ─────────────────────────────────────────── */

const state = {
  settings: getSettings(),
  sessions: [],
  current: null,
  messages: [],
  streaming: false,
  controller: null,
  editingMessageId: null,
  mascot: null,
  tts: null,
  stt: null,
  listening: false,
  sleepTimer: null,
  /** 语音提示音播放器 */
  chime: null,
};

/** 悬浮球控制器（boot 时创建），设置面板打开时用它刷新状态 */
let floatingBall = null;
/** 联网搜索的设置界面控制器 */
let searchUi = null;
/** 背景控制器（boot 时创建） */
let hddBackground = null;

/**
 * 初始化终端风格背景。
 *
 * 需求澄清（与早期实现的差异）：
 *   背景**不可拖动** —— 它是一层稳稳铺在内容之下的"环境"，
 *   而不是可以推来推去的画布。位置通过设置里的偏移量自定义，
 *   网格密度与亮度也各有滑块。
 *
 * ⚠️ 背景完全由代码绘制，不含任何游戏素材 ——
 * 风格可以借鉴，具体素材不能复用（与本项目移除内置录音同一原则）。
 */
function initBackground() {
  const canvas = $('#hdd-bg');
  if (!canvas) return;

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  hddBackground = createHddBackground(canvas, { reducedMotion: Boolean(reduced) });
  hddBackground.setTheme(state.settings.theme === 'light' ? 'light' : 'dark');
  hddBackground.setDensity(state.settings.bgDensity ?? 1);
  hddBackground.setBrightness(state.settings.bgBrightness ?? 1);
  // 位置偏移：用户可自定义，但不通过拖动改变
  hddBackground.setParallax(
    Number(state.settings.bgOffsetX) || 0,
    Number(state.settings.bgOffsetY) || 0,
  );
}

/** 绑定「界面」设置：融合强度、背景参数、提示音 */
function initAppearanceUi() {
  const chimeToggle = $('#set-chime-enabled');
  const presetSel = $('#set-chime-preset');
  const volRange = $('#set-chime-volume');
  const volOut = $('#out-chime-vol');
  const testBtn = $('#btn-chime-test');

  const fuseRange = $('#set-fuse');
  const fuseOut = $('#out-fuse');
  const densityRange = $('#set-bg-density');
  const densityOut = $('#out-bg-density');
  const brightRange = $('#set-bg-bright');
  const brightOut = $('#out-bg-bright');

  // 填充音色选项
  if (presetSel && !presetSel.options.length) {
    for (const p of Object.values(CHIME_PRESETS)) {
      presetSel.append(new Option(p.label, p.id));
    }
  }

  const s = state.settings;
  if (chimeToggle) chimeToggle.checked = s.chimeEnabled !== false;
  if (presetSel) presetSel.value = s.chimePreset || 'terminal';
  if (volRange) volRange.value = String(s.chimeVolume ?? 0.7);
  if (volOut) volOut.textContent = Number(s.chimeVolume ?? 0.7).toFixed(1);

  if (fuseRange) fuseRange.value = String(s.fuseLevel ?? 0.7);
  if (fuseOut) fuseOut.textContent = Number(s.fuseLevel ?? 0.7).toFixed(1);
  if (densityRange) densityRange.value = String(s.bgDensity ?? 1);
  if (densityOut) densityOut.textContent = Number(s.bgDensity ?? 1).toFixed(1);
  if (brightRange) brightRange.value = String(s.bgBrightness ?? 1);
  if (brightOut) brightOut.textContent = Number(s.bgBrightness ?? 1).toFixed(1);

  /* ── 融合强度 ── */
  fuseRange?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (fuseOut) fuseOut.textContent = v.toFixed(1);
    // 直接改 CSS 变量，滑块拖动时实时预览
    const root = document.documentElement;
    root.style.setProperty('--fuse', v.toFixed(3));
    root.style.setProperty('--fuse-inv', (1 - v).toFixed(3));
  });
  fuseRange?.addEventListener('change', (e) => {
    saveSettings({ fuseLevel: Number(e.target.value) });
  });

  /* ── 背景网格密度 ── */
  densityRange?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (densityOut) densityOut.textContent = v.toFixed(1);
    try { hddBackground?.setDensity?.(v); } catch { /* 忽略 */ }
  });
  densityRange?.addEventListener('change', (e) => {
    saveSettings({ bgDensity: Number(e.target.value) });
  });

  /* ── 背景亮度 ── */
  brightRange?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (brightOut) brightOut.textContent = v.toFixed(1);
    try { hddBackground?.setBrightness?.(v); } catch { /* 忽略 */ }
  });
  brightRange?.addEventListener('change', (e) => {
    saveSettings({ bgBrightness: Number(e.target.value) });
  });

  chimeToggle?.addEventListener('change', (e) => {
    saveSettings({ chimeEnabled: e.target.checked });
    // 打开时立刻响一声，让用户确认效果
    if (e.target.checked) {
      try {
        state.chime?.unlock();
        state.chime?.play(state.settings.chimePreset || 'terminal');
      } catch { /* 忽略 */ }
    }
  });

  presetSel?.addEventListener('change', (e) => {
    saveSettings({ chimePreset: e.target.value });
    try {
      state.chime?.unlock();
      state.chime?.play(e.target.value);
    } catch { /* 忽略 */ }
  });

  volRange?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (volOut) volOut.textContent = v.toFixed(1);
    saveSettings({ chimeVolume: v });
    try { state.chime?.setVolume(v); } catch { /* 忽略 */ }
  });
  // 松手时试听，拖动过程中不响（否则会连续叠加）
  volRange?.addEventListener('change', () => {
    try {
      state.chime?.unlock();
      state.chime?.play(state.settings.chimePreset || 'terminal');
    } catch { /* 忽略 */ }
  });

  testBtn?.addEventListener('click', () => {
    try {
      state.chime?.unlock();
      state.chime?.play(state.settings.chimePreset || 'terminal');
    } catch (err) {
      toast(`提示音播放失败：${err.message}`);
    }
  });
}

/* ── 主题 ─────────────────────────────────────────────── */

/**
 * 应用「界面融合」强度。
 *
 * 融合强度决定 UI 元素在多大程度上融入背景：
 *   0   → 传统卡片：实色底 + 圆角，最清晰
 *   1   → 完全融入：极淡底色 + 发光边，像背景网格的一部分
 *
 * 用 CSS 变量驱动（--fuse / --fuse-inv），样式表里所有相关元素
 * 都基于这两个变量计算，因此这里改一个数就能整体生效。
 * 默认值给 0.7：观感上已经融入背景，但文字对比度仍然充足。
 */
function applyFuse() {
  const level = Math.max(0, Math.min(1, Number(state.settings.fuseLevel ?? 0.7)));
  const root = document.documentElement;
  root.style.setProperty('--fuse', level.toFixed(3));
  root.style.setProperty('--fuse-inv', (1 - level).toFixed(3));
}

function applyTheme() {
  const pref = state.settings.theme;
  const dark = pref === 'dark'
    || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0f1318' : '#f2f5f8');
  safeMascot('setTheme', dark ? 'dark' : 'light');
  // 背景是 Canvas 绘制的，不会跟随 CSS 变量，需要显式通知
  try { hddBackground?.setTheme?.(dark ? 'dark' : 'light'); } catch { /* 忽略 */ }
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (state.settings.theme === 'system') applyTheme();
});

/* ── 立绘 ─────────────────────────────────────────────── */

async function initMascot() {
  const host = $('#mascot-host');
  const layer = $('#mascot-layer');
  if (!host || !layer) return;

  if (!state.settings.mascotVisible) { layer.dataset.hidden = 'true'; return; }

  try {
    state.mascot = createMascot(host, {
      theme: document.documentElement.dataset.theme || 'dark',
      scale: state.settings.scale / 100,
      animationSpeed: state.settings.animSpeed,
    });
  } catch (err) {
    console.warn('[fairy] 立绘初始化失败', err);
    layer.dataset.hidden = 'true';
    return;
  }

  restoreMascotPosition();
  bindMascotDrag();
  scheduleSleep();
}

/**
 * 安全调用立绘方法。
 * 立绘是装饰性增强：它的任何异常都不允许影响对话主链路。
 */
function safeMascot(method, ...args) {
  const mascot = state.mascot;
  if (!mascot || typeof mascot[method] !== 'function') return undefined;
  try {
    return mascot[method](...args);
  } catch (err) {
    console.warn(`[fairy] 立绘方法 ${method} 失败，已忽略`, err);
    return undefined;
  }
}

function setMascotState(next) {
  if (!state.mascot) return;
  const layer = $('#mascot-layer');
  if (layer) layer.dataset.state = next;
  safeMascot('setState', next);
}

/** 闲置一段时间后让 Fairy 睡下，任何交互都会唤醒 */
function scheduleSleep(ms = 90000) {
  clearTimeout(state.sleepTimer);
  if (!state.mascot) return;
  state.sleepTimer = setTimeout(() => {
    if (!state.streaming && !state.listening) setMascotState('sleeping');
  }, ms);
}

function wake() {
  if (!state.mascot) return;
  if (safeMascot('getState') === 'sleeping') setMascotState('idle');
  scheduleSleep();
}

/** 把立绘放到绝对坐标（px），并夹紧到视口内 */
function placeMascot(left, top) {
  const layer = $('#mascot-layer');
  if (!layer) return { left: 0, top: 0 };
  const size = layer.offsetWidth || 96;
  const maxLeft = Math.max(0, window.innerWidth - size);
  const maxTop = Math.max(0, window.innerHeight - size);
  const x = Math.min(Math.max(left, 0), maxLeft);
  const y = Math.min(Math.max(top, 0), maxTop);
  layer.style.left = `${x}px`;
  layer.style.top = `${y}px`;
  layer.style.right = 'auto';
  layer.style.bottom = 'auto';
  layer.style.transform = 'none';
  return { left: x, top: y };
}

function restoreMascotPosition() {
  const pos = state.settings.mascotPos;
  if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return;
  placeMascot(pos.x, pos.y);
}

function bindMascotDrag() {
  const handle = $('#mascot-handle');
  const layer = $('#mascot-layer');
  if (!handle || !layer) return;

  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let originLeft = 0;
  let originTop = 0;

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    dragging = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    const rect = layer.getBoundingClientRect();
    originLeft = rect.left;
    originTop = rect.top;
    layer.dataset.dragging = 'true';
    handle.setPointerCapture?.(e.pointerId);
    wake();
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!moved && Math.hypot(dx, dy) < 6) return;
    if (!moved) {
      // 第一次真正拖动时，先把当前位置固化为绝对坐标，避免 right/bottom 参考系跳变
      const rect = layer.getBoundingClientRect();
      originLeft = rect.left;
      originTop = rect.top;
      placeMascot(originLeft, originTop);
      moved = true;
    }
    placeMascot(originLeft + dx, originTop + dy);
  });

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    layer.dataset.dragging = 'false';
    handle.releasePointerCapture?.(e.pointerId);
    if (!moved) {
      toggleMascotMenu();
      return;
    }
    const rect = layer.getBoundingClientRect();
    patchSettings({ mascotPos: { x: Math.round(rect.left), y: Math.round(rect.top) } });
    state.settings = getSettings();
  };

  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);

  handle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleMascotMenu();
    }
  });

  window.addEventListener('resize', () => {
    const rect = layer.getBoundingClientRect();
    placeMascot(rect.left, rect.top);
  });
}

/* ── 立绘快捷菜单 ─────────────────────────────────────── */

function toggleMascotMenu(force) {
  const menu = $('#mascot-menu');
  const scrim = $('#mascot-menu-scrim');
  const layer = $('#mascot-layer');
  const open = force !== undefined ? force : menu.hidden;
  menu.hidden = !open;
  scrim.hidden = !open;
  menu.setAttribute('aria-hidden', String(!open));
  if (!open) return;

  const rect = layer.getBoundingClientRect();
  const mw = menu.offsetWidth || 200;
  const mh = menu.offsetHeight || 240;
  const left = Math.min(Math.max(rect.left + rect.width / 2 - mw / 2, 8), window.innerWidth - mw - 8);
  const top = rect.top - mh - 8 > 8 ? rect.top - mh - 8 : Math.min(rect.bottom + 8, window.innerHeight - mh - 8);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function bindMascotMenu() {
  $('#mascot-menu-scrim').addEventListener('click', () => toggleMascotMenu(false));
  $('#mascot-menu').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    toggleMascotMenu(false);
    if (action === 'new') await newSession();
    else if (action === 'read') speakLastAssistant();
    else if (action === 'auto-read') {
      state.settings = patchSettings({ autoRead: !state.settings.autoRead });
      syncSettingsUI();
      syncMascotMenu();
      toast(state.settings.autoRead ? '自动朗读已开启' : '自动朗读已关闭');
    } else if (action === 'balance') openPanel('#balance');
    else if (action === 'settings') openPanel('#settings');
    else if (action === 'sleep') {
      setMascotState('sleeping');
      toast('Fairy 转入低功耗待命。');
    }
  });
}

function syncMascotMenu() {
  const node = $('#mascot-menu [data-bind="auto-read"]');
  if (node) node.textContent = state.settings.autoRead ? '开' : '关';
}

/* ── 语音 ─────────────────────────────────────────────── */

/**
 * 生成一句准确的语音状态文案。
 *
 * 朗读现在走云端 TTS，因此关键信息是：
 *   - 用的是哪家服务
 *   - 配置是否完整（缺 Key 就是最常见的问题）
 *   - 是否在用克隆音色
 */
function describeSpeechState() {
  const bridge = typeof window !== 'undefined' ? window.AndroidBridge : null;
  const backend = describeCloudState();

  if (!bridge) {
    return state.tts
      ? `朗读使用浏览器语音合成（${backend.text}）。`
      : '此环境不支持语音朗读。';
  }
  return backend.ready
    ? `朗读使用${backend.text}。`
    : `云语音未就绪：${backend.text}`;
}

/** 汇总当前云语音配置状态（供状态文案与诊断共用） */
function describeCloudState() {
  const provider = resolveProvider(state.settings);
  const problem = validateConfig(state.settings, provider);
  const p = getProvider(provider);
  const usingClone = provider === 'siliconflow' && Boolean(String(state.settings.sfVoice || '').trim());
  if (problem) return { provider, ready: false, text: problem, usingClone };
  return {
    provider,
    ready: true,
    text: `${p.label}${usingClone ? '（Fairy 克隆音色）' : ''}`,
    usingClone,
  };
}


function renderVoiceDiagnostics() {
  const box = $('#voice-diag');
  if (!box) return;

  // 状态文案始终跟随真实诊断刷新，避免与诊断结论矛盾
  const noteNode = $('#speech-support');
  if (noteNode) noteNode.textContent = describeSpeechState();

  const bridge = typeof window !== 'undefined' ? window.AndroidBridge : null;
  const lines = [];

  lines.push(`运行环境：${bridge ? 'APK 壳内' : '普通浏览器'}`);

  // ── 云语音配置（当前的主要朗读路径）──
  const cloud = describeCloudState();
  const providerDef = getProvider(cloud.provider);
  lines.push(`云语音服务：${providerDef.label}`);
  lines.push(`配置状态：${cloud.ready ? '已就绪' : '未完成'}`);
  if (cloud.usingClone) {
    const vid = String(state.settings.sfVoice || '').trim();
    lines.push(`音色：Fairy 克隆音色（${vid.length > 28 ? `${vid.slice(0, 28)}…` : vid}）`);
  } else if (cloud.provider === 'siliconflow') {
    lines.push('音色：服务预置音色（可点「用录音克隆 Fairy 音色」）');
  }
  if (!cloud.ready) lines.push(`⚠ ${cloud.text}`);

  if (bridge) {
    try {
      if (typeof bridge.diag === 'function') {
        const info = JSON.parse(bridge.diag() || '{}');
        lines.push('');
        lines.push(`原生云语音：${info.cloudTts === '1' ? '可用' : '不可用'}`);
        lines.push(`合成后端：${info.backend || '未知'}`);
        lines.push(`系统引擎就绪：${info.ttsReady === '1' ? '是' : '否'}`);
        if (info.engine) lines.push(`当前引擎：${info.engine}`);
        lines.push(`Android SDK：${info.sdk}`);
        if (Array.isArray(info.engines)) {
          lines.push(`系统已装引擎：${info.engines.length ? info.engines.join('、') : '（无）'}`);
        }
        if (info.error) lines.push(`系统引擎提示：${info.error}`);
        if (info.cloudError) lines.push(`原生提示：${info.cloudError}`);

        // 识别后端
        try {
          if (typeof bridge.sttBackend === 'function') {
            const sb = bridge.sttBackend();
            const sbName = sb === 'system' ? '系统识别' : sb === 'cloud' ? '云识别'
              : sb === 'cloud-nocred' ? '云识别（未配置密钥）' : '无';
            lines.push(`识别后端：${sbName}`);
          }
        } catch (e) { /* 忽略 */ }

        if (info.crashInfo) {
          lines.push('');
          lines.push(`⚠ 本次启动出现异常：${info.crashInfo}`);
        }
        if (info.lastCrash) {
          lines.push('');
          lines.push('上次崩溃记录：');
          lines.push(String(info.lastCrash).split('\n').slice(0, 6).join('\n'));
        }
      }
    } catch (e) {
      lines.push(`原生诊断读取失败：${e.message}`);
    }
  } else {
    lines.push(`window.speechSynthesis：${typeof window.speechSynthesis}`);
    lines.push(`SpeechRecognition：${typeof (window.SpeechRecognition || window.webkitSpeechRecognition)}`);
  }

  // ── 提示下一步 ──
  lines.push('');
  if (!cloud.ready) {
    if (cloud.provider === 'siliconflow') {
      lines.push('→ 请填写 SiliconFlow API Key（cloud.siliconflow.cn 获取）。');
    } else if (cloud.provider === 'custom') {
      lines.push('→ 请填写自定义服务的 Base URL 与模型名。');
    } else {
      lines.push(`→ ${cloud.text}`);
    }
  } else if (!cloud.usingClone && cloud.provider === 'siliconflow') {
    lines.push('→ 想用 Fairy 本人的音色？点「用录音克隆 Fairy 音色」上传一段参考录音。');
  } else {
    lines.push('→ 配置完成。点「试听」确认效果。');
  }

  box.innerHTML = '';
  box.append(el('div', { class: 'field-note', text: lines.join('\n') }));
}

/**
 * 建立 Web Speech 兜底实例（仅浏览器环境需要）。
 *
 * 在 APK 内朗读走云端 TTS（见 speakText），这里只负责：
 *   - 浏览器里（无 AndroidBridge）用 Web Speech 朗读
 *   - 提供语音能力探测，供诊断展示
 */
function setupTts() {
  if (state.tts && !state.tts.isPlaceholder) return;
  if (!speechModule.isSpeechSynthesisSupported()) return;

  const next = speechModule.createTts({
    lang: 'zh-CN',
    rate: state.settings.rate,
    voiceURI: null,
  });
  if (next.isPlaceholder) return;

  state.tts?.destroy?.();
  state.tts = next;

  const note = $('#speech-support');
  if (note) note.textContent = describeSpeechState();
}

async function initSpeech() {
  const note = $('#speech-support');

  // ── 提示音 ──
  // 语音播报前先响一声，像终端在确认"我要说话了"。
  // 用 Web Audio 实时合成，不含任何音频素材。
  try {
    state.chime = createChime({ volume: Number(state.settings.chimeVolume) || 0.7 });
  } catch (err) {
    console.warn('[fairy] 提示音初始化失败', err);
    state.chime = null;
  }

  // 原生的 TTS 开始事件 → 播放提示音。
  // 选择这个时机而不是调用朗读时：云语音要先合成，
  // 提前响会让提示音与说话之间出现尴尬的静默。
  if (typeof window !== 'undefined') {
    window.__fairyVoice = window.__fairyVoice || {};
    const prevStart = window.__fairyVoice.onTtsStart;
    window.__fairyVoice.onTtsStart = () => {
      if (typeof prevStart === 'function') {
        try { prevStart(); } catch { /* 忽略 */ }
      }
      playChimeBeforeSpeech();
    };
  }

  // ── 朗读后端 ──
  //
  // APK 内的朗读走**云端 TTS**（由原生层发请求，规避 CORS），
  // 因此这里不再需要等待系统 TTS 引擎就绪。
  // 仍建立 Web Speech 实例作为浏览器环境的兜底。
  setupTts();
  if (note) note.textContent = describeSpeechState();
  renderVoiceDiagnostics();

  // ── 语音输入
  const sttSupported = speechModule.isRecognitionSupported
    && speechModule.isRecognitionSupported();
  if (!sttSupported) {
    $('#btn-mic').hidden = true;
    if (note) note.textContent = `${note.textContent ? `${note.textContent} ` : ''}此环境不支持语音输入。`;
    return;
  }

  state.stt = speechModule.createStt({ lang: 'zh-CN', continuous: true, interimResults: true });
  state.stt.onResult(({ text, isFinal }) => {
    const input = $('#input');
    if (isFinal) {
      state.interimBase = `${state.interimBase || ''}${text}`;
      input.value = state.interimBase;
    } else {
      input.value = `${state.interimBase || ''}${text}`;
    }
    autoGrow();
    updateComposerState();
  });
  state.stt.onError((err) => {
    setStatus(err?.message || '语音输入失败', 'error');
    stopListening();
  });
  state.stt.onEnd(() => {
    if (state.listening) stopListening();
  });
}


function unlockSpeechOnce() {
  if (!state.tts?.unlock) return;
  state.tts.unlock();
  document.removeEventListener('pointerdown', unlockSpeechOnce);
}

/**
 * 朗读一段文字。
 *
 * 优先走云端 TTS（可配置、支持 Fairy 克隆音色）；
 * 若云语音未配置或不可用，再退回系统语音引擎。
 */
/**
 * 播放语音播报前的提示音。
 *
 * 时机选择：**在真正开始出声的那一刻**，而不是调用朗读 API 时。
 * 原因：云语音需要先合成（几百毫秒到数秒），若在调用时就响提示音，
 * 中间会有一段尴尬的静默，听起来像"提示音响了但没人说话"。
 *
 * 系统引擎与云语音都会经过 window.__fairyVoice.onTtsStart，
 * 因此在那里统一触发，两种情况都能覆盖。
 */
function playChimeBeforeSpeech() {
  if (!state.settings.chimeEnabled) return;
  try {
    state.chime?.play(state.settings.chimePreset || 'terminal');
  } catch (err) {
    console.warn('[fairy] 提示音播放失败', err);
  }
}

function speakText(text, { auto = false } = {}) {
  const bridge = typeof window !== 'undefined' ? window.AndroidBridge : null;
  if (!bridge) {
    // 浏览器环境：交给 speech.js 的 Web Speech 实现
    if (!state.tts) {
      if (!auto) toast('当前环境不支持朗读。');
      return;
    }
    state.tts.cancel();
    setMascotState('speaking');
    // 浏览器下没有原生的 onTtsStart 事件，直接在这里响
    playChimeBeforeSpeech();
    state.tts.speak(text, {
      onEnd: () => { if (!state.streaming) setMascotState('idle'); },
      onError: () => { if (!state.streaming) setMascotState('idle'); },
    });
    return;
  }

  setMascotState('speaking');
  const provider = resolveProvider(state.settings);
  const hint = validateConfig(state.settings, provider);
  const canCloud = typeof bridge.ttsSpeakCloud === 'function' && !hint;

  try { bridge.ttsStop?.(); } catch { /* 忽略 */ }

  if (canCloud) {
    const params = buildSynthesisParams(state.settings, provider);
    try {
      bridge.ttsSpeakCloud(text, JSON.stringify(params));
      return;
    } catch (err) {
      console.warn('[fairy] 云朗读调用失败，回退系统引擎', err);
    }
  }

  // 回退：系统语音引擎
  if (typeof bridge.ttsSpeak === 'function') {
    try {
      bridge.ttsSpeak(text);
      return;
    } catch { /* 忽略 */ }
  }

  setMascotState('idle');
  if (!auto) {
    toast(hint ? `云语音未配置：${hint}` : '没有可用的语音引擎。');
  }
}

function speakLastAssistant() {
  const last = [...state.messages].reverse().find((m) => m.role === 'assistant' && m.content);
  if (!last) { toast('还没有可以朗读的回复。'); return; }
  speakText(last.content);
}

function startListening() {
  if (!state.stt) return;
  state.listening = true;
  state.interimBase = $('#input').value;
  $('#btn-mic').setAttribute('aria-pressed', 'true');
  setStatus('正在聆听…再次点击麦克风结束。');
  setMascotState('listening');
  try {
    state.stt.start();
  } catch (err) {
    setStatus('无法启动语音识别。', 'error');
    stopListening();
  }
}

function stopListening() {
  state.listening = false;
  $('#btn-mic').setAttribute('aria-pressed', 'false');
  setStatus('');
  state.stt?.stop?.();
  if (!state.streaming) setMascotState('idle');
}

/* ── 会话列表 ─────────────────────────────────────────── */

async function refreshSessions() {
  state.sessions = await listSessions();
}

async function renderSessionList(filter = '') {
  const list = $('#session-list');
  list.innerHTML = '';
  const keyword = filter.trim().toLowerCase();
  const rows = keyword
    ? state.sessions.filter((s) => String(s.title).toLowerCase().includes(keyword))
    : state.sessions;

  if (!rows.length) {
    list.append(el('p', {
      class: 'session-empty',
      text: keyword ? '没有匹配的会话。' : '还没有委托记录。点右上角 + 开始。',
    }));
    return;
  }

  for (const s of rows) {
    const item = el('div', {
      class: 'session-item',
      dataset: { active: String(s.id === state.current?.id), id: s.id },
      role: 'button',
      tabindex: '0',
    }, [
      el('span', { class: 's-text' }, [
        el('span', { class: 's-title', text: s.title || '新的委托' }),
        el('span', { class: 's-meta', text: `${formatTime(s.updatedAt)} · ${s.model || ''}` }),
      ]),
      el('button', {
        class: 's-del', type: 'button', 'aria-label': `删除会话 ${s.title}`, text: '×',
      }),
    ]);

    item.addEventListener('click', (e) => {
      if (e.target.closest('.s-del')) return;
      closeDrawer();
      openSession(s.id);
    });
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { closeDrawer(); openSession(s.id); }
    });
    item.querySelector('.s-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await confirmDialog(`删除「${s.title}」及其全部消息？`, { yes: '删除' });
      if (!ok) return;
      await deleteSession(s.id);
      if (state.current?.id === s.id) {
        state.current = null;
        state.messages = [];
        renderMessages();
      }
      await refreshSessions();
      renderSessionList($('#session-search').value);
      toast('已删除。');
    });

    list.append(item);
  }
}

/* ── 会话切换 ─────────────────────────────────────────── */

async function newSession() {
  if (state.streaming) stopGeneration();
  const session = await createSession('新的委托');
  await refreshSessions();
  await openSession(session.id);
  $('#input').focus();
}

async function openSession(id) {
  if (state.streaming) stopGeneration();
  const session = state.sessions.find((s) => s.id === id)
    || (await listSessions()).find((s) => s.id === id);
  if (!session) return;
  state.current = session;
  state.messages = await listMessages(id);
  renderMessages();
  await renderSessionList($('#session-search').value);
  updateTopbar();
  updateUsagePanel();
}

function updateTopbar() {
  const title = state.current?.title || '新的委托';
  $('#session-title').textContent = title;
  const sub = $('#session-sub');
  const count = state.messages.filter((m) => !m.error).length;
  if (state.streaming) sub.textContent = 'Fairy · 处理中';
  else if (count) sub.textContent = `Fairy · ${state.settings.model} · ${count} 条`;
  else sub.textContent = `Fairy · ${state.settings.model} · 待命`;
}

function updateEmptyState() {
  const empty = $('#empty-state');
  const hasMessages = state.messages.length > 0;
  empty.hidden = hasMessages;
  const warn = $('#key-warning');
  warn.hidden = Boolean(state.settings.apiKey);
}

/* ── 消息渲染 ─────────────────────────────────────────── */

function renderMessages() {
  const host = $('#messages');
  host.innerHTML = '';
  for (const m of state.messages) host.append(buildMessageNode(m));
  updateEmptyState();
  updateTopbar();
  scrollToBottom(true);
}

function buildMessageNode(msg) {
  const isUser = msg.role === 'user';
  const node = el('article', {
    class: `msg ${isUser ? 'user' : 'assistant'}${msg.error ? ' error' : ''}`,
    dataset: { id: msg.id },
  });

  node.append(el('div', { class: 'msg-role', text: isUser ? '主人' : 'Fairy' }));

  if (!isUser && msg.reasoning && state.settings.showReasoning) {
    node.append(buildReasoningNode(msg.reasoning));
  }

  const body = el('div', { class: 'msg-body' });
  body.innerHTML = isUser ? escapeHtml(msg.content).replace(/\n/g, '<br>') : renderMarkdown(msg.content);
  node.append(body);

  node.append(buildMessageTools(msg));
  return node;
}

function buildReasoningNode(text) {
  const details = el('details', { class: 'reasoning' });
  details.append(el('summary', { text: '推理过程' }));
  details.append(el('div', { class: 'reasoning-body', text }));
  return details;
}

function buildMessageTools(msg) {
  const tools = el('div', { class: 'msg-tools' });

  tools.append(el('button', {
    type: 'button', text: '复制',
    onclick: async () => {
      const ok = await copyText(msg.content);
      toast(ok ? '已复制。' : '复制失败，请长按选择文本。');
    },
  }));

  if (msg.role === 'assistant' && !msg.error) {
    tools.append(el('button', {
      type: 'button', text: '朗读',
      onclick: () => speakText(msg.content),
    }));
    tools.append(el('button', {
      type: 'button', text: '重新生成',
      onclick: () => regenerate(msg),
    }));
  }

  if (msg.role === 'user') {
    tools.append(el('button', {
      type: 'button', text: '重新发送',
      onclick: () => regenerate(msg),
    }));
  }

  tools.append(el('button', {
    type: 'button', text: '删除',
    onclick: async () => {
      const ok = await confirmDialog('删除这条消息？', { yes: '删除' });
      if (!ok) return;
      await deleteMessage(msg.id);
      state.messages = state.messages.filter((m) => m.id !== msg.id);
      renderMessages();
    },
  }));

  return tools;
}

function scrollToBottom(force = false) {
  const chat = $('#chat');
  if (!chat) return;
  const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 160;
  if (force || nearBottom) {
    requestAnimationFrame(() => { chat.scrollTop = chat.scrollHeight; });
  }
}

/* ── 发送与流式接收 ───────────────────────────────────── */

function setStatus(text, tone = '') {
  const node = $('#composer-status');
  node.textContent = text || '';
  node.dataset.tone = tone;
}

function updateComposerState() {
  const hasText = $('#input').value.trim().length > 0;
  $('#btn-send').hidden = state.streaming;
  $('#btn-stop').hidden = !state.streaming;
  $('#btn-send').disabled = !hasText;
}

function autoGrow() {
  const input = $('#input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.32)}px`;
}

function stopGeneration() {
  if (state.controller) {
    state.controller.abort();
    state.controller = null;
  }
  state.streaming = false;
  updateComposerState();
  updateTopbar();
  setStatus('');
  setMascotState('idle');
}

async function send(text) {
  const content = String(text || '').trim();
  if (!content) return;

  if (!state.settings.apiKey) {
    toast('请先在设置中填写 API Key。');
    openPanel('#settings');
    return;
  }
  if (!state.current) {
    const session = await createSession(titleFromText(content));
    state.current = session;
    await refreshSessions();
  }

  const input = $('#input');
  input.value = '';
  autoGrow();

  // 用户消息
  const seqBase = state.messages.length ? (state.messages[state.messages.length - 1].seq || 0) + 1 : 1;
  const userMsg = await addMessage({
    sessionId: state.current.id,
    role: 'user',
    content,
    seq: seqBase,
    model: state.settings.model,
  });
  state.messages.push(userMsg);
  $('#messages').append(buildMessageNode(userMsg));
  updateEmptyState();

  // 首条消息用于命名会话
  if (state.messages.filter((m) => m.role === 'user').length === 1) {
    const title = titleFromText(content);
    state.current = await updateSession(state.current.id, { title, updatedAt: new Date().toISOString() });
    await refreshSessions();
    renderSessionList($('#session-search').value);
    updateTopbar();
  }

  await runCompletion(seqBase + 1);
}

/** 执行一次助手生成；seq 为这条助手消息的序号 */
async function runCompletion(seq) {
  const settings = getSettings();
  state.settings = settings;

  const placeholderNode = el('article', { class: 'msg assistant', dataset: { pending: 'true' } }, [
    el('div', { class: 'msg-role', text: 'Fairy' }),
    el('div', { class: 'msg-body' }, [
      el('span', { class: 'thinking' }, [el('i'), el('i'), el('i')]),
    ]),
  ]);
  $('#messages').append(placeholderNode);
  scrollToBottom(true);

  state.streaming = true;
  updateComposerState();
  updateTopbar();
  setStatus('Fairy 正在处理…');
  setMascotState('thinking');

  const controller = new AbortController();
  state.controller = controller;

  let content = '';
  let reasoning = '';
  let usage = null;

  const paint = rafThrottle(() => {
    const body = placeholderNode.querySelector('.msg-body') || placeholderNode;
    const reasoningNode = placeholderNode.querySelector('.reasoning');
    if (reasoning && settings.showReasoning) {
      if (!placeholderNode.querySelector('.reasoning')) {
        const details = buildReasoningNode(reasoning);
        details.open = false;
        placeholderNode.insertBefore(details, body);
      } else if (reasoningNode) {
        reasoningNode.querySelector('.reasoning-body').textContent = reasoning;
      }
    }
    const html = renderMarkdown(content) || '<span class="thinking"><i></i><i></i><i></i></span>';
    body.innerHTML = `${html}<span class="cursor"></span>`;
    scrollToBottom();
  });

  const historyForRequest = state.messages;
  const systemPrompt = buildSystemPrompt(settings);
  let messages = buildRequestMessages(systemPrompt, historyForRequest);

  // ── 联网搜索（可选）
  //
  // 由关键词判断是否值得联网：日常闲聊、写作、代码问题不必搜，
  // 只有涉及实时信息时才查。搜不到就照常回答，不打断流程。
  const lastUser = [...state.messages].reverse().find((m) => m.role === 'user');
  if (settings.searchEnabled && lastUser && shouldSearch(lastUser.content)) {
    try {
      const query = buildQuery(lastUser.content);
      setStatus(`正在联网检索「${query}」…`);
      const found = await search(query, {
        engine: settings.searchEngine || 'bing',
        count: Number(settings.searchCount) || 5,
      });
      if (found.ok) {
        messages = injectSearchContext(messages, formatForPrompt(query, found.results));
        setStatus(`已获取 ${found.results.length} 条联网结果。`);
      } else {
        // 搜索失败不阻塞对话，只是没有额外资料
        console.warn('[fairy] 联网搜索未成功：', found.error);
        setStatus('');
      }
    } catch (err) {
      console.warn('[fairy] 联网搜索异常：', err);
      setStatus('');
    }
  }

  try {
    await streamChat({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
      messages,
      temperature: Number(settings.temperature),
      maxTokens: Number(settings.maxTokens),
    }, {
      onReasoning: (t) => { reasoning += t; paint(); },
      onContent: (t) => {
        if (!content && reasoning) setMascotState('speaking');
        content += t;
        paint();
      },
      onUsage: (u) => { usage = u; },
    }, controller.signal);

    if (controller.signal.aborted) {
      setStatus('已停止生成。');
    }

    const saved = await addMessage({
      sessionId: state.current.id,
      role: 'assistant',
      content: content || '（没有返回内容）',
      reasoning,
      seq,
      model: settings.model,
      usage,
    });
    state.messages.push(saved);

    placeholderNode.remove();
    $('#messages').append(buildMessageNode(saved));
    scrollToBottom();

    if (state.current) {
      state.current = await updateSession(state.current.id, { updatedAt: new Date().toISOString() });
      await refreshSessions();
    }

    if (saved.error !== true && settings.autoRead && !controller.signal.aborted) {
      try {
        speakText(saved.content, { auto: true });
      } catch (err) {
        console.warn('[fairy] 自动朗读失败', err);
      }
    } else if (!state.listening) {
      setMascotState('idle');
    }
    updateUsagePanel();
  } catch (err) {
    placeholderNode.remove();
    const aborted = err?.name === 'AbortError' || controller?.signal?.aborted;
    if (!aborted) {
      const message = err instanceof ApiError ? err.message : `请求失败：${err?.message || err}`;
      const saved = await addMessage({
        sessionId: state.current.id,
        role: 'assistant',
        content: message,
        seq,
        model: settings.model,
        error: true,
      });
      state.messages.push(saved);
      $('#messages').append(buildMessageNode(saved));
      setStatus(message, 'error');
      setMascotState('error');
      setTimeout(() => setMascotState('idle'), 2600);
      scrollToBottom();
    } else {
      setStatus('已停止生成。');
      setMascotState('idle');
    }
  } finally {
    state.streaming = false;
    state.controller = null;
    updateComposerState();
    updateTopbar();
    scheduleSleep();
  }
}

/** 从某条消息开始重做：删除它及其后的全部消息，再重新生成 */
async function regenerate(msg) {
  if (state.streaming) { toast('正在生成中，请先停止。'); return; }
  if (!state.current) return;

  const ok = await confirmDialog('将丢弃这条消息之后的内容并重新生成，继续？', { yes: '重新生成' });
  if (!ok) return;

  const seq = msg.seq ?? 0;
  await truncateAfter(state.current.id, seq);
  state.messages = await listMessages(state.current.id);
  renderMessages();

  if (msg.role === 'user') {
    // 重新发送这条用户消息：直接以它作为最后一条历史继续
    await runCompletion((state.messages[state.messages.length - 1]?.seq ?? seq) + 1);
  } else {
    await runCompletion(seq);
  }
}

/* ── 面板与抽屉 ───────────────────────────────────────── */

function openPanel(sel) {
  const panel = $(sel);
  if (!panel) return;
  // 面板互斥：避免设置页与余额页叠在一起导致视觉与焦点混乱
  $$('.panel').forEach((p) => { if (p !== panel && !p.hidden) closePanel(`#${p.id}`); });
  panel.hidden = false;
  panel.setAttribute('aria-hidden', 'false');
  panel.scrollTop = 0;
  const body = $('.panel-body', panel);
  if (body) body.scrollTop = 0;
  if (sel === '#balance') refreshBalance();
  if (sel === '#settings') {
    syncSettingsUI();
    // 悬浮球权限可能在系统设置里刚被授予，回到这里要立即反映真实状态
    try { floatingBall?.renderStatus?.(); } catch { /* 忽略 */ }
    try { searchUi?.syncUi?.(); } catch { /* 忽略 */ }
  }
}



function closePanel(sel) {
  const panel = $(sel);
  if (!panel) return;
  panel.hidden = true;
  panel.setAttribute('aria-hidden', 'true');
}

function openDrawer() {
  $('#drawer').dataset.open = 'true';
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#drawer-scrim').hidden = false;
  $('#btn-menu').setAttribute('aria-expanded', 'true');
}

function closeDrawer() {
  $('#drawer').dataset.open = 'false';
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#drawer-scrim').hidden = true;
  $('#btn-menu').setAttribute('aria-expanded', 'false');
}

/* ── 设置面板 ─────────────────────────────────────────── */

function syncSettingsUI() {
  const s = state.settings;
  $('#set-api-key').value = s.apiKey;
  $('#set-base-url').value = s.baseUrl;
  $('#set-temperature').value = s.temperature;
  $('#out-temp').textContent = Number(s.temperature).toFixed(1);
  $('#set-max-tokens').value = s.maxTokens;
  $('#out-maxtok').textContent = s.maxTokens;
  $('#set-show-reasoning').checked = s.showReasoning;
  $('#set-persona').checked = s.personaEnabled;
  $('#set-owner').value = s.owner;
  $('#set-owner-custom').value = s.ownerCustom;
  $('#owner-custom-field').hidden = s.owner !== '自定义';
  $('#set-extra-prompt').value = s.extraPrompt;
  $('#set-auto-read').checked = s.autoRead;
  $('#set-rate').value = s.rate;
  $('#out-rate').textContent = Number(s.rate).toFixed(1);
  $('#set-theme').value = s.theme;
  $('#set-scale').value = s.scale;
  $('#out-scale').textContent = `${s.scale}%`;
  $('#set-anim').value = s.animSpeed;
  $('#out-anim').textContent = `${Number(s.animSpeed).toFixed(1)}×`;
  $('#set-mascot-visible').checked = s.mascotVisible;
  $('#build-version').textContent = BUILD_VERSION;

  // ── 云语音字段 ──
  const set = (sel, val) => { const n = $(sel); if (n) n.value = val; };
  set('#set-tts-provider', s.ttsProvider || 'auto');
  set('#set-sf-key', s.sfApiKey || '');
  set('#set-sf-model', s.sfModel || 'FunAudioLLM/CosyVoice2-0.5B');
  set('#set-sf-voice', s.sfVoice || '');
  set('#set-sf-reftext', s.sfRefText || '');
  set('#set-custom-url', s.customBaseUrl || '');
  set('#set-custom-key', s.customApiKey || '');
  set('#set-custom-model', s.customModel || '');
  set('#set-custom-voice', s.customVoice || '');

  syncModelOptions();
  syncMascotMenu();
}

function syncModelOptions() {
  const select = $('#set-model');
  const models = (state.settings.models?.length ? state.settings.models : DEFAULT_MODELS);
  select.innerHTML = '';
  for (const id of models) select.append(el('option', { value: id, text: id }));
  if (!models.includes(state.settings.model)) {
    select.append(el('option', { value: state.settings.model, text: state.settings.model }));
  }
  select.value = state.settings.model;
}

function saveSettings(patch) {
  state.settings = patchSettings(patch);
  applyFuse();
  applyTheme();
  safeMascot('setScale', state.settings.scale / 100);
  safeMascot('setAnimationSpeed', state.settings.animSpeed);
  $('#mascot-layer').dataset.hidden = state.settings.mascotVisible ? 'false' : 'true';
  state.tts?.setRate?.(Number(state.settings.rate));
  // 语速同步给原生（系统引擎与云语音共用）
  try { window.AndroidBridge?.ttsSetRate?.(String(state.settings.rate)); } catch { /* 忽略 */ }
  updateEmptyState();
  updateTopbar();
}

function bindSettingsUI() {
  const commitText = debounce((key, value) => saveSettings({ [key]: value }), 350);

  $('#set-api-key').addEventListener('input', (e) => commitText('apiKey', e.target.value.trim()));
  $('#set-base-url').addEventListener('input', (e) => commitText('baseUrl', normalizeBaseUrl(e.target.value)));
  $('#set-base-url').addEventListener('blur', (e) => { e.target.value = normalizeBaseUrl(e.target.value); });
  $('#set-model').addEventListener('change', (e) => saveSettings({ model: e.target.value }));
  $('#set-temperature').addEventListener('input', (e) => {
    $('#out-temp').textContent = Number(e.target.value).toFixed(1);
    saveSettings({ temperature: Number(e.target.value) });
  });
  $('#set-max-tokens').addEventListener('input', (e) => {
    $('#out-maxtok').textContent = e.target.value;
    saveSettings({ maxTokens: Number(e.target.value) });
  });
  $('#set-show-reasoning').addEventListener('change', (e) => {
    saveSettings({ showReasoning: e.target.checked });
    renderMessages();
  });
  $('#set-persona').addEventListener('change', (e) => saveSettings({ personaEnabled: e.target.checked }));
  $('#set-owner').addEventListener('change', (e) => {
    $('#owner-custom-field').hidden = e.target.value !== '自定义';
    saveSettings({ owner: e.target.value });
  });
  $('#set-owner-custom').addEventListener('input', (e) => commitText('ownerCustom', e.target.value));
  $('#set-extra-prompt').addEventListener('input', (e) => commitText('extraPrompt', e.target.value));
  $('#set-auto-read').addEventListener('change', (e) => saveSettings({ autoRead: e.target.checked }));
  $('#set-rate').addEventListener('input', (e) => {
    $('#out-rate').textContent = Number(e.target.value).toFixed(1);
    saveSettings({ rate: Number(e.target.value) });
  });

  $('#set-theme').addEventListener('change', (e) => saveSettings({ theme: e.target.value }));
  $('#set-scale').addEventListener('input', (e) => {
    $('#out-scale').textContent = `${e.target.value}%`;
    saveSettings({ scale: Number(e.target.value) });
  });
  $('#set-anim').addEventListener('input', (e) => {
    $('#out-anim').textContent = `${Number(e.target.value).toFixed(1)}×`;
    saveSettings({ animSpeed: Number(e.target.value) });
  });
  $('#set-mascot-visible').addEventListener('change', (e) => saveSettings({ mascotVisible: e.target.checked }));

  $('#btn-test-voice').addEventListener('click', () => {
    speakText('检查完毕。语音通道正常，主人。');
  });

  $('#btn-voice-diag').addEventListener('click', () => {
    const box = $('#voice-diag');
    const actions = $('#voice-diag-actions');
    const show = box.hidden;
    box.hidden = !show;
    if (actions) actions.hidden = !show;
    if (show) {
      setupTts();
      renderVoiceDiagnostics();
    }
  });

  // 重试初始化原生 TTS（用户在系统里装了引擎之后用）
  $('#btn-tts-retry')?.addEventListener('click', () => {
    const bridge = typeof window !== 'undefined' ? window.AndroidBridge : null;
    if (!bridge || typeof bridge.ttsReinit !== 'function') {
      toast('当前不在 APK 内，无需重试。');
      return;
    }
    bridge.ttsReinit();
    toast('正在重新初始化语音引擎…');
    setTimeout(() => {
      setupTts();
      renderVoiceDiagnostics();
      if (state.tts && !state.tts.isPlaceholder) {
        toast('语音引擎已就绪。');
        speakText('语音通道已接通，主人。');
      } else {
        toast('仍未就绪，请检查系统语音引擎设置。');
      }
    }, 1500);
  });

  // 跳转系统「文字转语音」设置
  $('#btn-tts-settings')?.addEventListener('click', () => {
    const bridge = typeof window !== 'undefined' ? window.AndroidBridge : null;
    if (bridge && typeof bridge.openTtsSettings === 'function') bridge.openTtsSettings();
    else toast('当前不在 APK 内。');
  });

  // 准备 Fairy 本地克隆音色（仅完整版可用）


  // 复制诊断信息（方便直接反馈）
  $('#btn-copy-diag')?.addEventListener('click', async () => {
    renderVoiceDiagnostics();
    const box = $('#voice-diag');
    box.hidden = false;
    const actions = $('#voice-diag-actions');
    if (actions) actions.hidden = false;
    const text = box.textContent || '（无诊断信息）';
    const header = `=== Fairy 诊断 ===\nUA: ${navigator.userAgent}\n时间: ${new Date().toISOString()}\n\n`;
    const ok = await copyText(header + text);
    toast(ok ? '诊断信息已复制，可直接粘贴发送。' : '复制失败，请长按选择文本。');
  });

  // 清除上次崩溃记录
  $('#btn-clear-crash')?.addEventListener('click', () => {
    const bridge = typeof window !== 'undefined' ? window.AndroidBridge : null;
    if (bridge && typeof bridge.clearCrash === 'function') {
      bridge.clearCrash();
      toast('已清除崩溃记录。');
      renderVoiceDiagnostics();
    } else {
      toast('当前不在 APK 内。');
    }
  });

  // 删除已解压的模型以释放空间


  // 云识别凭据：保存到本机，并推送到原生
  const pushSttCredentials = debounce(() => {
    const bridge = typeof window !== 'undefined' ? window.AndroidBridge : null;
    if (bridge && typeof bridge.sttSetCredentials === 'function') {
      try {
        bridge.sttSetCredentials(state.settings.sttApiKey || '', state.settings.sttSecretKey || '');
      } catch (err) {
        console.warn('[fairy] 推送云识别凭据失败', err);
      }
    }
  }, 400);

  $('#set-stt-key')?.addEventListener('input', (e) => {
    saveSettings({ sttApiKey: e.target.value.trim() });
    pushSttCredentials();
  });
  $('#set-stt-secret')?.addEventListener('input', (e) => {
    saveSettings({ sttSecretKey: e.target.value.trim() });
    pushSttCredentials();
  });

  $('#btn-refresh-models').addEventListener('click', async () => {
    const note = $('#conn-result');
    note.className = 'field-note';
    note.textContent = '正在获取模型列表…';
    try {
      const ids = await listModels({ apiKey: state.settings.apiKey, baseUrl: state.settings.baseUrl });
      if (!ids.length) throw new Error('返回为空');
      saveSettings({ models: ids });
      syncModelOptions();
      note.className = 'field-note ok';
      note.textContent = `已获取 ${ids.length} 个模型：${ids.join('、')}`;
    } catch (err) {
      note.className = 'field-note bad';
      note.textContent = err instanceof ApiError ? err.message : `获取失败：${err.message}`;
    }
  });

  $('#btn-test-key').addEventListener('click', async () => {
    const note = $('#conn-result');
    note.className = 'field-note';
    note.textContent = '正在测试连接…';
    try {
      const bal = await getBalance({ apiKey: state.settings.apiKey, baseUrl: state.settings.baseUrl });
      const first = bal.infos[0];
      note.className = 'field-note ok';
      note.textContent = first
        ? `连接正常。余额 ${first.total} ${first.currency}。`
        : '连接正常，但未返回余额信息。';
    } catch (err) {
      note.className = 'field-note bad';
      note.textContent = err instanceof ApiError ? err.message : `连接失败：${err.message}`;
    }
  });

  $('#btn-export').addEventListener('click', async () => {
    const data = await exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', {
      href: url,
      download: `fairy-backup-${new Date().toISOString().slice(0, 10)}.json`,
    });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast(`已导出 ${data.sessions.length} 个会话。`);
  });

  $('#btn-import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const result = await importAll(payload);
      await refreshSessions();
      await renderSessionList($('#session-search').value);
      toast(`已导入 ${result.sessions} 个会话、${result.messages} 条消息。`);
    } catch (err) {
      toast(`导入失败：${err.message}`);
    }
  });

  $('#btn-clear-all').addEventListener('click', async () => {
    const ok = await confirmDialog('将删除本机全部会话、消息与设置（含 API Key），且不可恢复。继续？', { yes: '全部清空' });
    if (!ok) return;
    await clearAll();
    try { localStorage.clear(); } catch { /* 忽略 */ }
    location.reload();
  });

  $$('.panel-close').forEach((btn) => {
    btn.addEventListener('click', () => {
      const panel = btn.closest('.panel');
      if (panel) closePanel(`#${panel.id}`);
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    $$('.panel').forEach((p) => { if (!p.hidden) closePanel(`#${p.id}`); });
    toggleMascotMenu(false);
    closeDrawer();
  });
}

/* ── 余额面板 ─────────────────────────────────────────── */

async function refreshBalance() {
  const box = $('#balance-content');
  if (!state.settings.apiKey) {
    box.innerHTML = '<p class="field-note">尚未配置 API Key。</p>';
    return;
  }
  box.innerHTML = '<p class="field-note">读取中…</p>';
  try {
    const bal = await getBalance({ apiKey: state.settings.apiKey, baseUrl: state.settings.baseUrl });
    box.innerHTML = '';
    if (!bal.infos.length) {
      box.append(el('p', { class: 'field-note', text: '接口未返回余额信息。' }));
      return;
    }
    for (const info of bal.infos) {
      box.append(el('div', { class: 'balance-amount', text: `${info.total} ${info.currency}` }));
      box.append(el('div', { class: 'balance-line' }, [
        el('span', { text: '赠金余额' }), el('span', { text: `${info.granted} ${info.currency}` }),
      ]));
      box.append(el('div', { class: 'balance-line' }, [
        el('span', { text: '充值余额' }), el('span', { text: `${info.toppedUp} ${info.currency}` }),
      ]));
      box.append(el('div', { class: 'balance-line' }, [
        el('span', { text: '账户状态' }), el('span', { text: bal.isAvailable ? '可用' : '不可用' }),
      ]));
    }
  } catch (err) {
    box.innerHTML = '';
    box.append(el('p', {
      class: 'field-note bad',
      text: err instanceof ApiError ? err.message : `读取失败：${err.message}`,
    }));
  }
}

async function updateUsagePanel() {
  const box = $('#usage-content');
  if (!box) return;
  box.innerHTML = '';
  const assistants = state.messages.filter((m) => m.role === 'assistant' && m.usage);
  let prompt = 0;
  let completion = 0;
  for (const m of assistants) {
    prompt += m.usage.prompt_tokens || 0;
    completion += m.usage.completion_tokens || 0;
  }
  if (!assistants.length) {
    box.append(el('p', {
      class: 'field-note',
      text: '本次会话暂无用量数据（服务端未返回 usage 时不会统计）。',
    }));
  } else {
    box.append(el('div', { class: 'balance-line' }, [
      el('span', { text: '对话轮次' }), el('span', { text: String(assistants.length) }),
    ]));
    box.append(el('div', { class: 'balance-line' }, [
      el('span', { text: '输入 token' }), el('span', { text: String(prompt) }),
    ]));
    box.append(el('div', { class: 'balance-line' }, [
      el('span', { text: '输出 token' }), el('span', { text: String(completion) }),
    ]));
  }

  const usage = await estimateUsage();
  const note = $('#storage-note');
  if (note) {
    note.textContent = usage
      ? `本机占用约 ${(usage.usage / 1048576).toFixed(1)} MB / 可用约 ${(usage.quota / 1048576).toFixed(0)} MB。`
      : '本机存储占用信息不可用。';
  }
}

/* ── 输入区 ───────────────────────────────────────────── */

function bindComposer() {
  const input = $('#input');

  input.addEventListener('input', () => { autoGrow(); updateComposerState(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  $('#btn-send').addEventListener('click', submit);
  $('#btn-stop').addEventListener('click', stopGeneration);

  $('#btn-mic').addEventListener('click', () => {
    unlockSpeechOnce();
    if (state.listening) stopListening();
    else startListening();
  });

  $('#btn-scroll-bottom').addEventListener('click', () => scrollToBottom(true));
  $('#chat').addEventListener('scroll', () => {
    const chat = $('#chat');
    const far = chat.scrollHeight - chat.scrollTop - chat.clientHeight > 300;
    $('#btn-scroll-bottom').hidden = !far;
  });

  $$('#empty-actions .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      $('#input').value = chip.dataset.prompt || chip.textContent;
      autoGrow();
      updateComposerState();
      submit();
    });
  });
}

function submit() {
  if (state.streaming) return;
  const text = $('#input').value;
  if (!text.trim()) return;
  unlockSpeechOnce();
  send(text);
}

/* ── 全局事件 ─────────────────────────────────────────── */

function bindGlobal() {
  $('#btn-menu').addEventListener('click', openDrawer);
  $('#drawer-scrim').addEventListener('click', closeDrawer);
  $('#btn-drawer-close').addEventListener('click', closeDrawer);
  $('#btn-new').addEventListener('click', newSession);
  $('#btn-settings').addEventListener('click', () => { closeDrawer(); openPanel('#settings'); });
  $('#btn-balance').addEventListener('click', () => { closeDrawer(); openPanel('#balance'); });
  $('#btn-refresh-balance').addEventListener('click', refreshBalance);
  $('#session-search').addEventListener('input', debounce((e) => {
    renderSessionList(e.target.value);
  }, 180));

  document.addEventListener('pointerdown', wake, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) state.tts?.cancel?.();
  });

  // 消息区点击委托：外链（壳内）、代码块复制
  $('#messages').addEventListener('click', async (e) => {
    // 壳内运行：外链交给系统浏览器，避免 WebView 被带离应用
    const link = e.target.closest('a[href]');
    if (link && window.AndroidBridge && typeof window.AndroidBridge.openExternal === 'function') {
      const href = link.getAttribute('href');
      if (href && /^https?:/i.test(href)) {
        e.preventDefault();
        try { window.AndroidBridge.openExternal(href); } catch { /* 忽略 */ }
        return;
      }
    }

    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const code = btn.closest('.code-block')?.querySelector('code');
    if (!code) return;
    const ok = await copyText(code.textContent);
    toast(ok ? '代码已复制。' : '复制失败。');
  });
}

/* ── 启动 ─────────────────────────────────────────────── */

async function boot() {
  state.settings = getSettings();
  applyFuse();
  applyTheme();
  syncSettingsUI();
  bindGlobal();
  bindComposer();
  bindSettingsUI();
  bindMascotMenu();
  updateComposerState();

  // ── 视差背景 ──
  //
  // 背景是程序化绘制的终端风格图层（网格、扫描线、光晕），
  // 拖动对话区时远景缓慢移动、立绘明显位移，形成纵深。
  try {
    initBackground();
  } catch (err) {
    console.warn('[fairy] 背景初始化失败', err);
  }

  // ── 音频解锁 ──
  //
  // 移动端要求音频上下文由用户手势创建或恢复，否则提示音会被静默忽略。
  // 这里挂一次性监听，用户第一次触碰页面时解锁。
  const unlockAudio = () => {
    try { state.chime?.unlock(); } catch { /* 忽略 */ }
    document.removeEventListener('pointerdown', unlockAudio);
    document.removeEventListener('keydown', unlockAudio);
  };
  document.addEventListener('pointerdown', unlockAudio, { passive: true });
  document.addEventListener('keydown', unlockAudio);

  // 云端语音设置界面（提供商选择、克隆音色等）
  initCloudTtsUi({
    getSettings: () => state.settings,
    save: (patch) => saveSettings(patch),
    speak: (text) => speakText(text),
    onChange: () => { syncSettingsUI(); renderVoiceDiagnostics(); },
  });

  // 悬浮球（语音唤醒入口）
  floatingBall = initFloatingBall({
    getSettings: () => state.settings,
    save: (patch) => saveSettings(patch),
    startListening: () => startListening(),
    setStatus: (text, tone) => setStatus(text, tone),
  });

  // 联网搜索设置
  searchUi = initSearchUi({
    getSettings: () => state.settings,
    save: (patch) => saveSettings(patch),
  });

  // 界面：视差背景与提示音
  initAppearanceUi();

  // 启动时把云识别凭据推给原生（原生侧不持久化，每次启动都要推）
  try {
    const bridge = typeof window !== 'undefined' ? window.AndroidBridge : null;
    if (bridge && typeof bridge.sttSetCredentials === 'function') {
      bridge.sttSetCredentials(state.settings.sttApiKey || '', state.settings.sttSecretKey || '');
    }
  } catch (err) {
    console.warn('[fairy] 推送云识别凭据失败', err);
  }

  await initMascot();
  await initSpeech();

  await refreshSessions();
  renderSessionList();

  if (state.sessions.length) {
    await openSession(state.sessions[0].id);
  } else {
    state.current = null;
    state.messages = [];
    renderMessages();
  }
  updateEmptyState();
  updateUsagePanel();

  // 离线能力：仅在生产式部署下注册，file:// 打开时跳过
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.warn('[fairy] Service Worker 注册失败', err);
    });
  }

  window.addEventListener('error', (e) => {
    console.error('[fairy] 未捕获错误', e.error || e.message);
  });
}

/**
 * 测试钩子：供 tools/verify-voice.mjs 在真实浏览器里验证状态文案。
 * 只暴露纯函数与设置读写，不改变任何生产行为。
 */
window.__fairyTest = {
  /** 在默认设置基础上覆盖若干字段（保证场景之间互不污染） */
  resetSettings(json) {
    try {
      const base = { ...DEFAULT_SETTINGS };
      state.settings = { ...base, ...JSON.parse(json) };
    } catch (err) {
      console.warn('[fairy] 测试钩子解析设置失败', err);
    }
  },
  applySettings(json) {
    try {
      state.settings = { ...state.settings, ...JSON.parse(json) };
    } catch (err) {
      console.warn('[fairy] 测试钩子解析设置失败', err);
    }
  },
  describeSpeechState,
  describeCloudState,
};

boot();
