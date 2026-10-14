/**
 * fairy-mobile/js/speech.js
 *
 * 手机版 DeepSeek Fairy PWA 的「浏览器原生语音模块」。
 *
 * 设计目标（与桌面版 dsh-fairy-voice 的关键区别）：
 *   - 桌面版把 PCM 音频流交给本地 sherpa-onnx TTS 代理播放（Web Audio + fetch）。
 *   - 手机版**完全不依赖任何 Node / 代理 / 网络服务**，只使用浏览器原生能力：
 *       TTS: window.speechSynthesis + SpeechSynthesisUtterance
 *       STT: window.SpeechRecognition || window.webkitSpeechRecognition
 *
 * 硬性约束：
 *   1. 零依赖、纯浏览器、ES Module。
 *   2. 模块顶层**不得**触碰 window / document / speechSynthesis。
 *      所有环境探测都在函数调用时惰性进行，这样 stripForSpeech / chunkForSpeech
 *      这两个纯函数可以直接在 Node 里做单元测试（`import` 本身不会失败）。
 *   3. 所有 API 在能力缺失时都必须「安全降级」，不允许抛错。
 *
 * ---------------------------------------------------------------------------
 * iOS Safari 重要提示（调用方必读）
 * ---------------------------------------------------------------------------
 * iOS Safari（以及部分 Android WebView）要求**第一次 speak() 必须发生在用户手势
 * 的同步调用栈内**（click / touchend 等）。若在 setTimeout / await / fetch 回调之后
 * 才第一次调用 speak()，Safari 会静默丢弃这次朗读（没有任何报错）。
 *
 * 因此本模块额外提供 createTts().unlock()：
 *   在页面加载后、任何异步朗读之前，用户在任意按钮上第一次交互时调用一次：
 *
 *     button.addEventListener('click', () => tts.unlock(), { once: true });
 *
 *   unlock() 会以 volume≈0 播放一个空 utterance，把系统语音通道「解锁」，
 *   之后再从任意异步上下文调用 speak() 都能正常发声。
 *
 * 另一个 iOS 注意点：Safari 的语音列表在冷启动时是空的，且 voiceschanged 事件
 * 是异步/有时不触发；请使用 onVoicesChanged(cb) 订阅，不要假设 listVoices() 立刻非空。
 * ---------------------------------------------------------------------------
 */

/* ========================================================================== *
 * 常量与小工具（全部为纯函数 / 惰性，无模块级副作用）
 * ========================================================================== */

/** 朗读分段默认最大长度（字符数）。浏览器对单条超长 utterance 有超时/截断问题。 */
const DEFAULT_MAX_LEN = 120;

/** 中英文句末 / 分句标点，用于 chunkForSpeech 切句。 */
const SENTENCE_BREAK_RE = /([。！？；…‥!?;…\n\r]+(?:["'”’」』】）》)]*))/;

/** 英文缩写等「假句号」：不在此处切句。 */
const FALSE_DOT_RE = /\b(?:Mr|Mrs|Ms|Dr|Prof|St|vs|etc|No|Fig|Inc|Ltd|Jr|Sr|Approx|approx|e\.g|i\.e)\.$/i;

/** 行级：Markdown 表格分隔行，例如 |---|:--:|---| */
const TABLE_SEPARATOR_RE = /^[\s|:-]*-[\s|:-]*$/;

/** 行级：只由竖线/破折号/冒号组成的噪声行 */
const TABLE_BORDER_RE = /^\s*[|+\-:=]{3,}\s*$/;

/** 行级：水平分割线 */
const HR_RE = /^\s*(?:[-*_]\s*){3,}$/;

/** HTML 标签 */
const HTML_TAG_RE = /<\/?[A-Za-z][^<>]*>/g;

/** Markdown 图片：![alt](url) / ![alt][ref] —— 整段丢弃（alt 通常不是给耳朵听的内容）。 */
const MD_IMAGE_RE = /!\[[^\]]*\]\([^()]*\)/g;
const MD_IMAGE_REF_RE = /!\[[^\]]*\]\[[^\]]*\]/g;

/** Markdown 链接：[文字](url) / [文字][ref] —— 保留「文字」，丢弃 URL。 */
const MD_LINK_RE = /\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g;
const MD_LINK_REF_RE = /\[([^\]]*)\]\[[^\]]*\]/g;

/** 引用式链接定义 / 脚注定义行：[1]: https://... */
const LINK_DEF_LINE_RE = /^\s*\[[^\]]+\]:\s*\S+.*$/;

/** 裸 URL / 裸邮箱 —— 念出来毫无意义，直接去掉。 */
const BARE_URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'）】)，。；！？、]+/gi;
const BARE_EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/** 内联代码 `code` —— 通常在念之前已由代码块规则处理，这里兜底去掉反引号保留内容。 */
const INLINE_CODE_RE = /`([^`]*)`/g;

/** 行首结构化标记：标题、引用、列表、任务列表、编号列表。 */
const LEADING_MARK_RE = /^[ \t]*(?:>[ \t]?|#{1,6}[ \t]+|[-*+][ \t]+|\[[ xX]\][ \t]+|(?:\d{1,3}[.)])[ \t]+)+/;

/** 强调 / 删除线 / 高亮标记 */
const EMPHASIS_RE = /(\*\*\*|\*\*|___|__|\*|_|~~|==)/g;

/** HTML 实体（常见子集，避免引入 DOM 解析）。 */
const HTML_ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>',
  '&quot;': '"', '&#39;': "'", '&apos;': "'", '&hellip;': '…', '&mdash;': '—',
};

/** 代码围栏行：``` 或 ~~~（允许缩进与 info string） */
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

/** 全角/半角空白归一 */
const MULTI_SPACE_RE = /[ \t\u00A0\u3000]+/g;
const MULTI_NEWLINE_RE = /\n{2,}/g;

/**
 * 表情符号（emoji）与装饰符号的剔除。
 *
 * 优先使用 ES2018 的 `\p{Extended_Pictographic}`（现代浏览器与 Node 均支持），
 * 一次正则解决所有情况。
 *
 * 若不支持（老引擎），**不要**退回到「把代理对区间写进正则字符类」的做法：
 * V8 对同一字符类内相邻的低代理 `\uDF00-\uDDFF` 会报 "Range out of order"，
 * 这类正则会直接把模块打挂。这里改为**按码点遍历**：
 *   - 码点用 String.prototype.codePointAt 正确读取（代理对自动合并）；
 *   - 命中区间即整枚丢弃（含变体选择符 VS16 与零宽连接符 ZWJ）。
 * 纯函数、无副作用，且在各引擎上行为一致。
 */
const EMOJI_RE = (() => {
  try {
    // eslint-disable-next-line no-new
    new RegExp('\\p{Extended_Pictographic}', 'u');
    return /[\p{Extended_Pictographic}\u200D\uFE0F]/gu;
  } catch {
    return null; // 交由下面的码点遍历实现处理
  }
})();

/** 需要剔除的码点区间（含端点），按升序排列。 */
const EMOJI_CODE_POINT_RANGES = Object.freeze([
  [0x200d, 0x200d], // ZWJ
  [0x2190, 0x21ff], // 箭头
  [0x2300, 0x23ff], // 技术符号（⌚⏰等）
  [0x2600, 0x27bf], // 杂项符号 / 装饰符号（☀✔❤✈）
  [0x2b00, 0x2bff], // 杂项符号与箭头（⬛⭐）
  [0xfe0f, 0xfe0f], // 变体选择符 VS16
  [0x1f000, 0x1f0ff], // 麻将牌等
  [0x1f300, 0x1f5ff], // 杂项符号与象形文字（🌀🗿）
  [0x1f600, 0x1f64f], // 表情（😀🙏）
  [0x1f680, 0x1f6ff], // 交通与地图符号（🚀🛰）
  [0x1f900, 0x1f9ff], // 补充符号与象形文字（🤖🧠）
  [0x1fa00, 0x1faff], // 扩展符号与象形文字（🫀🫶）
]);

function isEmojiCodePoint(cp) {
  for (const [start, end] of EMOJI_CODE_POINT_RANGES) {
    if (cp >= start && cp <= end) return true;
  }
  return false;
}

/** 剔除 emoji / 装饰符号 / ZWJ / VS16（纯函数）。 */
function stripEmoji(text) {
  if (EMOJI_RE) return text.replace(EMOJI_RE, '');
  let output = '';
  for (let index = 0; index < text.length; index += 1) {
    const cp = text.codePointAt(index);
    if (typeof cp !== 'number') continue;
    // 星号/井号/数字等 ASCII 由区间天然排除，不会被误删。
    if (!isEmojiCodePoint(cp)) {
      output += String.fromCodePoint(cp);
    }
    if (cp > 0xffff) index += 1; // 跳过代理对的低位
  }
  return output;
}

/** 数字/长度安全钳制（纯函数） */
function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/** 极简事件订阅器（纯内存，无副作用；供 TTS / STT 共用） */
function createEmitter() {
  const listeners = new Set();
  return {
    add(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(payload) {
      // 复制一份再遍历：回调内部退订不会破坏本次派发。
      for (const listener of [...listeners]) {
        try {
          listener(payload);
        } catch {
          /* 订阅者异常不得影响语音主流程 */
        }
      }
    },
    clear() {
      listeners.clear();
    },
    get size() {
      return listeners.size;
    },
  };
}

/* ========================================================================== *
 * 纯函数 1：stripForSpeech
 * ========================================================================== */

/**
 * 把 Markdown 正文清洗为「适合朗读的纯文本」。
 *
 * 处理内容：围栏代码块、行内代码、图片、链接（保留文字）、裸 URL/邮箱、
 * 引用式链接定义、HTML 标签与实体、标题/引用/列表标记、强调标记、
 * 表格（分隔行丢弃，数据行的单元格用「，」连接）、水平线、emoji、
 * 多余的空白与空行。
 *
 * 纯函数：无副作用、确定性、不访问任何全局状态。
 *
 * @param {string} markdownText 原始 Markdown（或任意文本）
 * @returns {string} 可朗读的纯文本
 */
export function stripForSpeech(markdownText) {
  if (markdownText == null) return '';
  let text = String(markdownText);
  if (!text) return '';

  // 统一换行，避免 \r\n / \r 干扰逐行处理。
  text = text.replace(/\r\n?/g, '\n');

  const lines = text.split('\n');
  const out = [];
  let fence = null; // 当前所处的代码围栏标记（null 表示不在代码块内）

  for (const rawLine of lines) {
    const fenceMatch = FENCE_RE.exec(rawLine);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fence) fence = marker;
      else if (fence === marker) fence = null;
      continue; // 围栏行本身以及代码块内容都不朗读
    }
    // 代码块内部：整行丢弃（含 shell 片段、JSON、日志等）。
    if (fence) continue;

    // 引用式链接定义 / 脚注定义：整行丢弃。
    if (LINK_DEF_LINE_RE.test(rawLine)) continue;

    // 水平线、表格边框噪声：整行丢弃。
    if (HR_RE.test(rawLine)) continue;
    if (TABLE_BORDER_RE.test(rawLine)) continue;

    // 表格分隔行（|---|:--:|）丢弃。
    if (rawLine.includes('|') && TABLE_SEPARATOR_RE.test(rawLine)) continue;

    let line = rawLine;

    // 表格数据行：拆出单元格，用中文逗号连接，让语音有自然停顿。
    if (line.includes('|')) {
      const cells = line
        .replace(/^\s*\|/, '')
        .replace(/\|\s*$/, '')
        .split('|')
        .map((cell) => cell.trim())
        .filter(Boolean);
      line = cells.join('，');
    }

    out.push(line);
  }

  text = out.join('\n');

  // 图片整段丢弃（先于链接处理，否则 ![]() 会被链接规则吃掉一半）。
  text = text.replace(MD_IMAGE_RE, ' ');
  text = text.replace(MD_IMAGE_REF_RE, ' ');

  // 链接只保留可读文字。
  text = text.replace(MD_LINK_RE, '$1');
  text = text.replace(MD_LINK_REF_RE, '$1');

  // 裸 URL / 邮箱。
  text = text.replace(BARE_URL_RE, ' ');
  text = text.replace(BARE_EMAIL_RE, ' ');

  // 行内代码：保留内容但去掉反引号（此时真正的代码块已经不存在了）。
  text = text.replace(INLINE_CODE_RE, '$1');

  // HTML 标签与实体。
  text = text.replace(HTML_TAG_RE, ' ');
  text = text.replace(/&[a-zA-Z#0-9]+;/g, (entity) => {
    const key = entity.toLowerCase();
    return Object.prototype.hasOwnProperty.call(HTML_ENTITIES, key)
      ? HTML_ENTITIES[key]
      : ' ';
  });

  // 逐行去掉行首结构化标记与行尾多余空白。
  text = text
    .split('\n')
    .map((line) => line.replace(LEADING_MARK_RE, '').trimEnd())
    .join('\n');

  // 强调标记。
  text = text.replace(EMPHASIS_RE, '');

  // emoji / 变体选择符 / 零宽连接符。
  text = stripEmoji(text);

  // 归一空白：行内多空格 -> 单空格；多空行 -> 单换行（朗读不需要空行停顿）。
  text = text
    .split('\n')
    .map((line) => line.replace(MULTI_SPACE_RE, ' ').trim())
    .join('\n');
  text = text.replace(MULTI_NEWLINE_RE, '\n');

  // 收尾：去掉因删除标记而残留的孤立标点/空白。
  text = text
    .split('\n')
    .map((line) => line.replace(/^[\s，。、；：,.:;]+/, '').replace(/\s+$/g, ''))
    .filter((line) => line.replace(/[\s，。、；：,.:;!?！？~～—\-]/g, '').length > 0)
    .join('\n');

  return text.trim();
}

/* ========================================================================== *
 * 纯函数 2：chunkForSpeech
 * ========================================================================== */

/**
 * 把一段文本切成若干「不超过 maxLen」的朗读片段。
 *
 * 策略：
 *   1. 先在一次正则扫描中按句末标点（。！？；…!?;）与换行切开，标点跟随前一句；
 *      中英文逗号/顿号作为次级切点。
 *   2. 再贪婪合并相邻片段，只要合并后不超过 maxLen 就继续合并
 *      （避免为了逐句朗读而产生过多碎片）。
 *   3. 仍超长的片段（例如整段无标点的长文）按 maxLen 硬切，保证硬约束成立。
 *
 * 纯函数：无副作用、确定性，不访问全局状态。
 *
 * @param {string} text
 * @param {number} [maxLen=120] 每段最大字符数；非法值回退到默认值。
 * @returns {string[]} 非空片段数组；输入为空/非字符串时返回 `[]`。
 */
export function chunkForSpeech(text, maxLen = DEFAULT_MAX_LEN) {
  if (text == null) return [];
  const source = String(text);
  if (!source) return [];

  const limit = Number.isFinite(Number(maxLen)) && Number(maxLen) > 0
    ? Math.max(1, Math.floor(Number(maxLen)))
    : DEFAULT_MAX_LEN;

  // 1) 切成「片段」（保留标点）。
  const segments = [];
  for (const rawLine of source.replace(/\r\n?/g, '\n').split('\n')) {
    if (!rawLine) {
      segments.push('\n');
      continue;
    }
    const parts = rawLine.split(SENTENCE_BREAK_RE);
    for (const part of parts) {
      if (part) segments.push(part);
    }
  }

  // 合并「假句号」切点：把 "e.g." 的 "." 与后文拼回去，减少误切。
  const merged = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (previous && previous !== '\n' && FALSE_DOT_RE.test(previous)) {
      merged[merged.length - 1] = previous + segment;
    } else {
      merged.push(segment);
    }
  }

  // 2) 贪婪合并到 limit 以内。
  const chunks = [];
  let current = '';
  const flush = () => {
    const piece = current.trim();
    if (piece) chunks.push(piece);
    current = '';
  };

  for (const segment of merged) {
    const piece = segment === '\n' ? ' ' : segment;
    if (current && current.length + piece.length > limit) flush();
    current += piece;
    // 单个片段本身超长（无标点长文）：就地硬切，保证每段 ≤ limit。
    while (current.length > limit) {
      const head = current.slice(0, limit).trim();
      if (head) chunks.push(head);
      current = current.slice(limit);
    }
  }
  flush();

  // 3) 兜底：过滤空/纯空白片段。
  return chunks.filter((chunk) => chunk.length > 0);
}

/** 中文逗号/顿号等次级切点（导出供调用方自行做更细的切分时复用）。 */
export const SECONDARY_BREAK_RE = /([，、,])/;

/* ========================================================================== *
 * 能力探测（惰性，绝不在模块顶层求值）
 * ========================================================================== */

/** 当前环境是否存在可用的 speechSynthesis。 */
export function isSpeechSynthesisSupported() {
  try {
    if (typeof window === 'undefined') return false;
    // 原生桥优先：Android WebView 里 window.speechSynthesis 对象可能存在，
    // 但因为没有语音引擎而**实际不可用**（speak 静默失败）。此时必须走原生 TTS。
    if (nativeTtsAvailable()) return true;
    // 壳内但原生未就绪：报告为「可用」由调用方按占位处理，避免误判为不支持
    if (isNativeShell()) return true;
    return typeof window.speechSynthesis === 'object'
      && window.speechSynthesis !== null
      && typeof window.SpeechSynthesisUtterance === 'function';
  } catch {
    return false;
  }
}

/** 当前环境是否存在可用的语音识别实现。 */
export function isRecognitionSupported() {
  try {
    if (typeof window === 'undefined') return false;
    // 原生桥优先：WebView 里 SpeechRecognition 通常不存在，只有原生可用
    if (nativeSttAvailable()) return true;
    return typeof (window.SpeechRecognition || window.webkitSpeechRecognition) === 'function';
  } catch {
    return false;
  }
}

/** 惰性取得 speechSynthesis（不存在时返回 null，不抛错）。 */
function getSynth() {
  try {
    return isSpeechSynthesisSupported() ? window.speechSynthesis : null;
  } catch {
    return null;
  }
}

/* ========================================================================== *
 * 原生桥（Android WebView 壳内：TextToSpeech / SpeechRecognizer）
 *
 * 协议：
 *   JS → 原生：window.AndroidBridge.{ttsSpeak,ttsStop,ttsSetRate,ttsSetPitch,
 *                ttsIsSpeaking,ttsListVoices,ttsSetVoice,sttStart,sttStop,sttCancel,...}
 *   原生 → JS：通过 evaluateJavascript 调用 window.__fairyVoice.* 回传事件。
 * ========================================================================== */

let nativeHooksInstalled = false;
let activeNativeTts = null; // { onStart, onEnd, onError }
let activeNativeStt = null; // { onResult, onError, onEnd }

function getNativeBridge() {
  try {
    if (typeof window === 'undefined') return null;
    const bridge = window.AndroidBridge;
    return bridge && typeof bridge === 'object' ? bridge : null;
  } catch {
    return null;
  }
}

/** 原生桥的布尔约定：统一走字符串 "1"/"0"（@JavascriptInterface 对 Boolean 不可靠） */
function nativeBool(value) {
  return value === '1' || value === 1 || value === true;
}

function nativeTtsAvailable() {
  try {
    const b = getNativeBridge();
    return !!(b && typeof b.ttsSpeak === 'function' && typeof b.ttsSupported === 'function'
      && nativeBool(b.ttsSupported()));
  } catch {
    return false;
  }
}

function nativeSttAvailable() {
  try {
    const b = getNativeBridge();
    return !!(b && typeof b.sttStart === 'function' && typeof b.sttSupported === 'function'
      && nativeBool(b.sttSupported()));
  } catch {
    return false;
  }
}

/** 壳内原生语音识别不可用时的占位 STT：安全 no-op 并明确报不支持。 */
function createNullStt() {
  const errorEmitter = createEmitter();
  const endEmitter = createEmitter();
  return {
    isPlaceholder: true,
    isSupported: () => false,
    start() { errorEmitter.emit({ code: 'unsupported', message: '语音识别尚未就绪' }); },
    stop() {}, abort() {},
    onResult: () => () => {},
    onError: (cb) => errorEmitter.add(cb),
    onEnd: (cb) => endEmitter.add(cb),
    destroy() { errorEmitter.clear(); endEmitter.clear(); },
  };
}

/**
 * 壳内原生尚未就绪时的占位 TTS：所有方法安全 no-op。
 * 调用方应在收到 onNativeTtsReady(true) 后重新 createTts()。
 */
function createNullTts() {
  const config = { voiceURI: null, rate: 1, pitch: 1, volume: 1 };
  return {
    isPlaceholder: true,
    speak: () => Promise.resolve(),
    cancel() {}, pause() {}, resume() {},
    isSpeaking: () => false,
    isPaused: () => false,
    listVoices: () => [],
    setVoice(uri) { config.voiceURI = uri || null; return true; },
    setRate(n) { config.rate = clampNumber(n, 0.1, 10, config.rate); return config.rate; },
    setPitch(n) { config.pitch = clampNumber(n, 0, 2, config.pitch); return config.pitch; },
    setVolume(n) { config.volume = clampNumber(n, 0, 1, config.volume); return config.volume; },
    getConfig: () => ({ ...config }),
    unlock() {},
    onVoicesChanged: () => () => {},
    destroy() {},
  };
}

/**
 * 原生 TTS 是否**此刻**已就绪。
 * 与 isSpeechSynthesisSupported() 的区别：这个函数在原生环境下不会回退到
 * Web Speech，专门用于「壳内到底该不该建实例」的判断。
 */
export function nativeTtsReady() {
  return nativeTtsAvailable();
}

/** 是否运行在原生壳内（存在 AndroidBridge） */
export function isNativeShell() {
  try {
    const b = getNativeBridge();
    return !!(b && typeof b.ttsSupported === 'function');
  } catch {
    return false;
  }
}

/**
 * 订阅原生 TTS 就绪事件。
 *
 * TextToSpeech 的初始化是异步的，页面启动时探测可能赶在就绪之前。
 * 但**只是被动等 onTtsReady 回调并不够**：原生可能在 JS 执行到
 * installNativeHooks() 之前就已就绪，那次回调会落空，之后再也不触发。
 * 因此这里同时用低频轮询兜底，拿到就绪即停止。
 *
 * @param {(ready:boolean)=>void} cb
 * @returns {Function} 取消订阅
 */
export function onNativeTtsReady(cb) {
  if (typeof cb !== 'function') return () => {};

  const bridge = getNativeBridge();
  // 非原生环境（纯浏览器）：不订阅也不轮询
  if (!bridge || typeof bridge.ttsSupported !== 'function') return () => {};

  installNativeHooks();
  nativeTtsReadySubscribers.add(cb);

  let attempts = 0;
  let done = false;

  const run = () => {
    if (done) return;
    let ready = false;
    try { ready = nativeBool(bridge.ttsSupported()); } catch { ready = false; }
    // 未就绪时也回一次 false，让调用方知道当前状态
    try { cb(ready); } catch { /* 忽略 */ }
    if (ready) {
      done = true;
      stopPoll();
    }
  };

  // 立即补一次（可能已经就绪）
  const initial = setTimeout(run, 0);
  if (typeof initial?.unref === 'function') initial.unref();

  // 轮询兜底：每 250ms 查一次，最多 ~15s（覆盖冷启动时 TTS 引擎加载较慢的情况）
  let poll = null;
  const stopPoll = () => {
    if (poll != null) { clearInterval(poll); poll = null; }
  };
  poll = setInterval(() => {
    attempts += 1;
    if (attempts > 60) { stopPoll(); return; }
    run();
  }, 250);
  if (typeof poll?.unref === 'function') poll.unref();

  return () => {
    done = true;
    clearTimeout(initial);
    stopPoll();
    nativeTtsReadySubscribers.delete(cb);
  };
}

const nativeTtsReadySubscribers = new Set();

/** 安装一次 window.__fairyVoice，把原生回传事件转发给当前生效的实例。 */
function installNativeHooks() {
  if (nativeHooksInstalled) return;
  nativeHooksInstalled = true;
  try {
    if (typeof window === 'undefined') return;
    // 用合并而非整体替换：其它模块（如悬浮球）可能已经在这个对象上挂了回调，
    // 直接赋值会把它们悄悄抹掉 —— 表现就是「回调注册了却永不触发」。
    const hooks = window.__fairyVoice = window.__fairyVoice || {};
    Object.assign(hooks, {
      onTtsReady(ready) {
        try {
          for (const cb of [...nativeTtsReadySubscribers]) {
            try { cb(nativeBool(ready)); } catch { /* 忽略 */ }
          }
        } catch { /* 忽略 */ }
      },
      onTtsStart() { try { activeNativeTts?.onStart?.(); } catch { /* 忽略 */ } },
      onTtsEnd() { try { activeNativeTts?.onEnd?.(); } catch { /* 忽略 */ } },
      onTtsError(message) { try { activeNativeTts?.onError?.(message || '朗读失败'); } catch { /* 忽略 */ } },
      onSttResult(text, isFinal) { try { activeNativeStt?.onResult?.(String(text ?? ''), isFinal === true); } catch { /* 忽略 */ } },
      onSttError(message) { try { activeNativeStt?.onError?.(message || '语音识别失败'); } catch { /* 忽略 */ } },
      onSttEnd() { try { activeNativeStt?.onEnd?.(); } catch { /* 忽略 */ } },
    });
  } catch {
    /* 忽略 */
  }
}

function createNativeTts(options = {}) {
  installNativeHooks();
  const config = {
    lang: typeof options.lang === 'string' && options.lang ? options.lang : 'zh-CN',
    rate: clampNumber(options.rate, 0.1, 10, 1),
    pitch: clampNumber(options.pitch, 0, 2, 1),
    volume: clampNumber(options.volume, 0, 1, 1),
    voiceURI: typeof options.voiceURI === 'string' && options.voiceURI ? options.voiceURI : null,
  };

  let destroyed = false;
  let token = 0;
  let current = null; // { token, resolve, handlers }
  let watchdog = null;

  const voicesEmitter = createEmitter();

  function clearWatchdog() {
    if (watchdog != null) {
      clearTimeout(watchdog);
      watchdog = null;
    }
  }

  function finishCurrent() {
    clearWatchdog();
    if (!current) return;
    const c = current;
    current = null;
    try { c.handlers.onEnd?.(); } catch { /* 忽略 */ }
    c.resolve();
  }

  activeNativeTts = {
    onStart() { try { current?.handlers.onStart?.(); } catch { /* 忽略 */ } },
    onEnd() { finishCurrent(); },
    onError(message) {
      if (!current) return;
      const c = current;
      clearWatchdog();
      current = null;
      try { c.handlers.onError?.({ message: message || '朗读失败' }); } catch { /* 忽略 */ }
      c.resolve();
    },
  };

  function speak(text, handlers = {}) {
    if (destroyed) return Promise.resolve();
    const bridge = getNativeBridge();
    if (!bridge || typeof bridge.ttsSpeak !== 'function') return Promise.resolve();
    cancel(); // 先清掉上一条，避免叠音
    const t = ++token;
    return new Promise((resolve) => {
      current = { token: t, resolve, handlers };
      try {
        bridge.ttsSpeak(String(text ?? ''));
      } catch {
        finishCurrent();
        return;
      }
      // 看门狗：原生若始终不回 onEnd，按文本长度估算超时主动收尾
      const ms = Math.max(2500, Math.min(90000, (String(text ?? '').length * 700) / Math.max(config.rate, 0.1)));
      watchdog = setTimeout(() => {
        if (current && current.token === t) finishCurrent();
      }, ms);
      if (typeof watchdog?.unref === 'function') watchdog.unref();
    });
  }

  function cancel() {
    const bridge = getNativeBridge();
    try { bridge?.ttsStop?.(); } catch { /* 忽略 */ }
    finishCurrent();
  }

  function pause() { /* 原生 TTS 不提供暂停，安全 no-op */ }
  function resume() { /* no-op */ }

  function isSpeaking() {
    const bridge = getNativeBridge();
    try {
      if (bridge && typeof bridge.ttsIsSpeaking === 'function') return nativeBool(bridge.ttsIsSpeaking());
    } catch { /* 忽略 */ }
    return current != null;
  }

  function isPaused() { return false; }

  function listVoices() {
    const bridge = getNativeBridge();
    try {
      if (bridge && typeof bridge.ttsListVoices === 'function') {
        const parsed = JSON.parse(bridge.ttsListVoices() || '[]');
        if (Array.isArray(parsed) && parsed.length) return parsed;
      }
    } catch { /* 忽略 */ }
    return [{ uri: 'native-default', name: '系统默认', lang: config.lang, local: true }];
  }

  function setVoice(uri) {
    config.voiceURI = uri || null;
    const bridge = getNativeBridge();
    try { bridge?.ttsSetVoice?.(uri || ''); } catch { /* 忽略 */ }
    return true;
  }

  function setRate(n) {
    config.rate = clampNumber(n, 0.1, 10, config.rate);
    const bridge = getNativeBridge();
    try { bridge?.ttsSetRate?.(config.rate); } catch { /* 忽略 */ }
    return config.rate;
  }

  function setPitch(n) {
    config.pitch = clampNumber(n, 0, 2, config.pitch);
    const bridge = getNativeBridge();
    try { bridge?.ttsSetPitch?.(config.pitch); } catch { /* 忽略 */ }
    return config.pitch;
  }

  function setVolume(n) {
    config.volume = clampNumber(n, 0, 1, config.volume);
    return config.volume;
  }

  function getConfig() {
    return { voiceURI: config.voiceURI, rate: config.rate, pitch: config.pitch, volume: config.volume };
  }

  function unlock() { /* 原生 TTS 无需手势解锁 */ }

  function onVoicesChanged(cb) {
    const off = voicesEmitter.add(cb);
    // 原生语音列表不变，立即回填一次即可
    const timer = setTimeout(() => { if (!destroyed) voicesEmitter.emit(listVoices()); }, 0);
    if (typeof timer?.unref === 'function') timer.unref();
    return off;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    cancel();
    activeNativeTts = null;
    voicesEmitter.clear();
  }

  return {
    speak, cancel, pause, resume, isSpeaking, isPaused,
    listVoices, setVoice, setRate, setPitch, setVolume,
    getConfig, unlock, onVoicesChanged, destroy,
  };
}

function createNativeStt(options = {}) {
  installNativeHooks();
  const config = {
    lang: typeof options.lang === 'string' && options.lang ? options.lang : 'zh-CN',
    continuous: options.continuous !== false,
    interimResults: options.interimResults !== false,
  };

  const resultEmitter = createEmitter();
  const errorEmitter = createEmitter();
  const endEmitter = createEmitter();

  let listening = false;
  let aborted = false;
  let destroyed = false;

  function isSupported() { return nativeSttAvailable(); }

  /** Android 识别是一次性的；continuous 下由 JS 主动续听（稍加延迟避免忙错误）。 */
  function maybeRestart() {
    if (destroyed || !listening || aborted || !config.continuous) return;
    const bridge = getNativeBridge();
    if (!bridge) return;
    const timer = setTimeout(() => {
      if (destroyed || !listening || aborted) return;
      try {
        bridge.sttStart(config.lang);
      } catch {
        listening = false;
        endEmitter.emit();
      }
    }, 160);
    if (typeof timer?.unref === 'function') timer.unref();
  }

  activeNativeStt = {
    onResult(text, isFinal) {
      if (destroyed) return;
      resultEmitter.emit({ text, isFinal });
      if (isFinal) {
        if (listening && !aborted && config.continuous) {
          maybeRestart();
        } else if (listening) {
          listening = false;
          endEmitter.emit();
        }
      }
    },
    onError(message) {
      if (destroyed) return;
      const wasListening = listening;
      listening = false;
      errorEmitter.emit({ code: 'native', message: message || '语音识别失败' });
      if (wasListening) endEmitter.emit();
    },
    onEnd() {
      if (destroyed) return;
      if (listening && !aborted && config.continuous) {
        maybeRestart();
      } else if (listening) {
        listening = false;
        endEmitter.emit();
      }
    },
  };

  function start() {
    if (destroyed) return;
    if (!isSupported()) {
      errorEmitter.emit({ code: 'unsupported', message: '当前环境不支持语音识别' });
      return;
    }
    aborted = false;
    listening = true;
    const bridge = getNativeBridge();
    try {
      bridge.sttStart(config.lang);
    } catch {
      listening = false;
      errorEmitter.emit({ code: 'native', message: '无法启动语音识别' });
    }
  }

  function stop() {
    listening = false;
    const bridge = getNativeBridge();
    try { bridge?.sttStop?.(); } catch { /* 忽略 */ }
  }

  function abort() {
    aborted = true;
    listening = false;
    const bridge = getNativeBridge();
    try { bridge?.sttCancel?.(); } catch { /* 忽略 */ }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    abort();
    activeNativeStt = null;
    resultEmitter.clear();
    errorEmitter.clear();
    endEmitter.clear();
  }

  return {
    isSupported, start, stop, abort,
    onResult: (cb) => resultEmitter.add(cb),
    onError: (cb) => errorEmitter.add(cb),
    onEnd: (cb) => endEmitter.add(cb),
    destroy,
  };
}

/* ========================================================================== *
 * createTts
 * ========================================================================== */

/**
 * 创建 TTS 朗读器（基于浏览器原生 Web Speech API）。
 *
 * @param {object} [options]
 * @param {string} [options.lang='zh-CN']
 * @param {number} [options.rate=1]    语速 0.1–10
 * @param {number} [options.pitch=1]   音高 0–2
 * @param {number} [options.volume=1]  音量 0–1
 * @param {string|null} [options.voiceURI=null]
 * @returns {{
 *   speak(text: string, handlers?: object): Promise<void>,
 *   cancel(): void, pause(): void, resume(): void,
 *   isSpeaking(): boolean, isPaused(): boolean,
 *   listVoices(): Array<{uri:string,name:string,lang:string,local:boolean}>,
 *   setVoice(uri: string|null): boolean, setRate(n: number): number,
 *   setPitch(n: number): number, setVolume(n: number): number,
 *   getConfig(): {voiceURI: string|null, rate: number, pitch: number, volume: number},
 *   unlock(): void,
 *   onVoicesChanged(cb: Function): Function,
 *   destroy(): void
 * }}
 */
export function createTts(options = {}) {
  if (nativeTtsAvailable()) return createNativeTts(options);

  // 壳内（存在 AndroidBridge）但原生 TTS 尚未就绪时，**不能**回退到 Web Speech：
  // WebView 里 window.speechSynthesis 往往存在却没有可用引擎，建出来的实例
  // 永远不出声。此时返回一个「占位空实现」，等 onNativeTtsReady 通知就绪后
  // 调用方会重新 createTts() 建出真正的原生实例。
  if (isNativeShell()) return createNullTts();

  const config = {    lang: typeof options.lang === 'string' && options.lang ? options.lang : 'zh-CN',
    rate: clampNumber(options.rate, 0.1, 10, 1),
    pitch: clampNumber(options.pitch, 0, 2, 1),
    volume: clampNumber(options.volume, 0, 1, 1),
    voiceURI: typeof options.voiceURI === 'string' && options.voiceURI ? options.voiceURI : null,
  };

  let destroyed = false;
  let speakToken = 0; // 代次：cancel/speak/destroy 后旧代次的回调全部失效

  let watchdogTimer = null;   // Android Chrome 「卡住」看门狗
  let pollVoicesTimer = null; // voiceschanged 不触发时的轮询兜底
  let activeUtterance = null; // 当前正在朗读的 utterance（诊断/调试用）

  /**
   * 代次 -> 收尾函数。
   * cancel() 会让所有挂起朗读的代次失效，此时必须主动把它们的 Promise
   * 以 resolve 结束（契约：被 cancel 时 resolve，不 reject、不悬空）。
   */
  const pendingClosers = new Map();

  const voicesEmitter = createEmitter();

  /** 把 SpeechSynthesisVoice 归一化为本模块的公开结构。 */
  function normalizeVoice(voice) {
    return {
      uri: String(voice?.voiceURI || voice?.name || ''),
      name: String(voice?.name || ''),
      lang: String(voice?.lang || ''),
      local: voice?.localService !== false,
    };
  }

  function listVoices() {
    const synth = getSynth();
    if (!synth) return [];
    try {
      const voices = synth.getVoices();
      return Array.isArray(voices) ? voices.map(normalizeVoice) : [];
    } catch {
      return [];
    }
  }

  /** 按 voiceURI 解析出真正的 SpeechSynthesisVoice（找不到返回 null）。 */
  function resolveVoice() {
    if (!config.voiceURI) return null;
    const synth = getSynth();
    if (!synth) return null;
    try {
      const voices = synth.getVoices() || [];
      return voices.find((voice) => voice.voiceURI === config.voiceURI || voice.name === config.voiceURI) || null;
    } catch {
      return null;
    }
  }

  function clearWatchdog() {
    if (watchdogTimer != null) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  }

  function stopVoicePolling() {
    if (pollVoicesTimer != null) {
      clearInterval(pollVoicesTimer);
      pollVoicesTimer = null;
    }
  }

  // ---- 原生语音列表监听（voiceschanged 是异步的，且个别浏览器不触发） ----
  // 惰性挂载：只有当调用方真正订阅时才注册，避免模块导入 / createTts 产生副作用。
  let nativeVoicesListenerAttached = false;
  function attachNativeVoicesListener() {
    if (nativeVoicesListenerAttached) return;
    const synth = getSynth();
    if (!synth) return;
    nativeVoicesListenerAttached = true;
    try {
      synth.addEventListener?.('voiceschanged', handleNativeVoicesChanged);
    } catch {
      try {
        synth.onvoiceschanged = handleNativeVoicesChanged;
      } catch {
        /* 忽略：部分实现不支持事件 */
      }
    }
    // 冷启动时语音列表可能稍后才就绪；用低频轮询兜底，拿到列表即停止。
    if (listVoices().length === 0 && pollVoicesTimer == null) {
      let attempts = 0;
      pollVoicesTimer = setInterval(() => {
        attempts += 1;
        const voices = listVoices();
        if (voices.length > 0) {
          stopVoicePolling();
          voicesEmitter.emit(voices);
        } else if (attempts >= 20 || destroyed) {
          stopVoicePolling();
        }
      }, 250);
      // Node / 无 unref 环境兼容
      if (typeof pollVoicesTimer?.unref === 'function') pollVoicesTimer.unref();
    }
  }

  function handleNativeVoicesChanged() {
    voicesEmitter.emit(listVoices());
  }

  /**
   * 订阅语音列表变化。
   * @param {(voices: Array<object>) => void} cb
   * @returns {Function} 取消订阅函数
   */
  function onVoicesChanged(cb) {
    if (typeof cb !== 'function') return () => {};
    attachNativeVoicesListener();
    const off = voicesEmitter.add(cb);
    // 若此刻已经有语音，立即回调一次，调用方无需轮询。
    const voices = listVoices();
    if (voices.length > 0) {
      try {
        cb(voices);
      } catch {
        /* 订阅者异常忽略 */
      }
    }
    return () => {
      off();
    };
  }

  /**
   * iOS Safari 解锁：必须在用户手势（click/touchend）中调用一次。
   * 播放一个极短、近乎无声的 utterance，把系统语音通道打开。
   * 不产生任何 Promise，失败也不抛错。
   */
  function unlock() {
    const synth = getSynth();
    if (!synth || destroyed) return;
    try {
      const Utterance = window.SpeechSynthesisUtterance;
      const utterance = new Utterance(' ');
      utterance.volume = 0;
      utterance.rate = 10;
      utterance.pitch = 0.1;
      utterance.lang = config.lang;
      const voice = resolveVoice();
      if (voice) utterance.voice = voice;
      synth.speak(utterance);
    } catch {
      /* 忽略：解锁失败只影响后续是否发声，不影响接口契约 */
    }
  }

  /** 语音合成不可用时的安全空实现。 */
  function speakUnavailable(handlers) {
    // 立即 resolve（不 reject），并依然给出 onStart/onEnd 语义，方便调用方统一处理。
    Promise.resolve().then(() => {
      try { handlers.onStart?.(); } catch { /* 忽略 */ }
      try { handlers.onEnd?.(); } catch { /* 忽略 */ }
    });
    return Promise.resolve();
  }

  /**
   * 朗读文本。会先 cancel() 掉上一条，避免叠音。
   *
   * @param {string} text
   * @param {object} [handlers] { onStart, onEnd, onBoundary, onError }
   * @returns {Promise<void>} 正常结束或**被 cancel 时**都以 resolve 结束，绝不 reject。
   */
  function speak(text, handlers = {}) {
    const onStart = typeof handlers.onStart === 'function' ? handlers.onStart : null;
    const onEnd = typeof handlers.onEnd === 'function' ? handlers.onEnd : null;
    const onBoundary = typeof handlers.onBoundary === 'function' ? handlers.onBoundary : null;
    const onError = typeof handlers.onError === 'function' ? handlers.onError : null;

    if (destroyed) return Promise.resolve();

    // 文本清洗 + 长文本切分
    const clean = stripForSpeech(text);
    const chunks = chunkForSpeech(clean, DEFAULT_MAX_LEN);

    if (chunks.length === 0) {
      // 清洗后没有可朗读内容：视为「无声结束」，同步回调但不报错。
      Promise.resolve().then(() => {
        try { onStart?.(); } catch { /* 忽略 */ }
        try { onEnd?.(); } catch { /* 忽略 */ }
      });
      return Promise.resolve();
    }

    const synth = getSynth();
    if (!synth) return speakUnavailable({ onStart, onEnd });

    // 1) 先掐掉上一条（含 Chrome 的 pause() 卡死问题）。
    //    直接用底层实现：cancel() 会自增 speakToken，而这里必须保留本次代次。
    stopEngine();

    const token = ++speakToken;

    return new Promise((resolve) => {
      let index = 0;
      let settled = false;

      /**
       * 结束本次朗读。**无论正常播完还是被 cancel()，都只走这一条路径**，
       * 因此 speak() 的 Promise 永远以 resolve 收敛，绝不 reject、绝不悬空。
       */
      const close = () => {
        if (settled) return;
        settled = true;
        pendingClosers.delete(token);
        clearWatchdog();
        activeUtterance = null;
        try { onEnd?.(); } catch { /* 忽略 */ }
        resolve();
      };

      /** 单调推进到下一段；全部播完则结束。 */
      const advance = () => {
        if (settled || token !== speakToken) return;
        clearWatchdog();
        index += 1;
        if (index >= chunks.length) {
          close();
          return;
        }
        speakChunk();
      };

      // 被 cancel() / destroy() 打断（speakToken 已变）时，仍然收起 Promise。
      const onInvalidated = () => close();

      pendingClosers.set(token, onInvalidated);

      /**
       * 看门狗：按文本长度估算合理耗时，超时后主动推进。
       * Android Chrome 有时不触发 onend，导致 Promise 永久悬着。
       * 估算公式：中文约 6 字/秒 @rate=1；英文约 12 字/秒。
       * 取估算值的 ~3 倍并加最小 2.5s 缓冲，宁可晚一点也不要误切。
       */
      function armWatchdog(chunk) {
        if (settled || token !== speakToken) return;
        const cjk = (chunk.match(/[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g) || []).length;
        const latin = Math.max(0, chunk.length - cjk);
        const seconds = (cjk / 6 + latin / 12) / config.rate;
        const timeout = Math.max(2500, seconds * 1000 * 3 + 1200);
        clearWatchdog();
        watchdogTimer = setTimeout(() => {
          watchdogTimer = null;
          if (settled || token !== speakToken) return;
          // 引擎卡住：主动推进到下一段（或结束），保证 Promise 一定收敛。
          advance();
        }, timeout);
        if (typeof watchdogTimer?.unref === 'function') watchdogTimer.unref();
      }

      function speakChunk() {
        if (settled || token !== speakToken) return;
        const chunk = chunks[index];
        let utterance;
        try {
          utterance = new window.SpeechSynthesisUtterance(chunk);
        } catch (error) {
          try { onError?.(error); } catch { /* 忽略 */ }
          advance();
          return;
        }

        utterance.lang = config.lang;
        utterance.rate = config.rate;
        utterance.pitch = config.pitch;
        utterance.volume = config.volume;
        const voice = resolveVoice();
        if (voice) utterance.voice = voice;

        utterance.onstart = () => {
          if (settled || token !== speakToken) return;
          // 每段开播时重置看门狗，避免上一段的估算干扰。
          armWatchdog(chunk);
          try { onStart?.(); } catch { /* 忽略 */ }
        };
        utterance.onboundary = (event) => {
          if (settled || token !== speakToken) return;
          // 有边界事件说明引擎仍在推进，推迟看门狗。
          armWatchdog(chunk);
          try {
            onBoundary?.({
              charIndex: event?.charIndex ?? 0,
              charLength: event?.charLength ?? 0,
              name: event?.name || '',
              index,
            });
          } catch { /* 忽略 */ }
        };
        utterance.onend = () => {
          if (settled || token !== speakToken) return;
          advance();
        };
        utterance.onerror = (event) => {
          if (settled || token !== speakToken) return;
          const error = event?.error || 'synthesis-failed';
          // canceled / interrupted 是主动 cancel 的正常结果，不视为错误。
          if (error !== 'canceled' && error !== 'interrupted') {
            try { onError?.(new Error(String(error))); } catch { /* 忽略 */ }
          }
          advance();
        };

        activeUtterance = utterance;

        try {
          // Chrome 的已知问题：synthesis 处于 paused 状态时 speak() 会静默排队。
          if (synth.paused) synth.resume();
          synth.speak(utterance);
          // 部分实现不触发 onstart，这里兜底先武装看门狗。
          armWatchdog(chunk);
        } catch (error) {
          try { onError?.(error); } catch { /* 忽略 */ }
          advance();
        }
      }

      speakChunk();
    });
  }

  /**
   * 底层停止：让所有挂起回调失效并调用原生 cancel()。
   * 不负责 Promise 收尾（那是 pendingClosers 的职责）。
   */
  function stopEngine() {
    speakToken += 1; // 让当前所有挂起的回调与看门狗失效
    clearWatchdog();
    activeUtterance = null;
    const synth = getSynth();
    if (synth) {
      try { synth.cancel(); } catch { /* 忽略 */ }
      try {
        // cancel 之后若仍处于 paused，部分 Chrome 版本会永久卡住后续朗读。
        if (synth.paused) synth.resume();
      } catch { /* 忽略 */ }
    }
    // 通知被中断的朗读：Promise 以 resolve 结束（不 reject）。
    for (const [token, closer] of [...pendingClosers]) {
      pendingClosers.delete(token);
      try { closer(); } catch { /* 忽略 */ }
    }
  }

  /** 立即停止朗读。speak 的 Promise 会以 resolve 结束（不 reject）。 */
  function cancel() {
    stopEngine();
  }

  /** 暂停朗读（部分移动端实现不支持，失败静默）。 */
  function pause() {
    const synth = getSynth();
    if (!synth) return;
    try { synth.pause(); } catch { /* 忽略 */ }
  }

  /** 恢复朗读。 */
  function resume() {
    const synth = getSynth();
    if (!synth) return;
    try { synth.resume(); } catch { /* 忽略 */ }
  }

  function isSpeaking() {
    const synth = getSynth();
    if (!synth) return false;
    try { return synth.speaking === true; } catch { return false; }
  }

  function isPaused() {
    const synth = getSynth();
    if (!synth) return false;
    try { return synth.paused === true; } catch { return false; }
  }

  /** 设置发音人（voiceURI；传 null/'' 表示用浏览器默认）。 */
  function setVoice(uri) {
    config.voiceURI = typeof uri === 'string' && uri ? uri : null;
    return config.voiceURI !== null;
  }

  function setRate(value) {
    config.rate = clampNumber(value, 0.1, 10, config.rate);
    return config.rate;
  }

  function setPitch(value) {
    config.pitch = clampNumber(value, 0, 2, config.pitch);
    return config.pitch;
  }

  function setVolume(value) {
    config.volume = clampNumber(value, 0, 1, config.volume);
    return config.volume;
  }

  function getConfig() {
    return {
      voiceURI: config.voiceURI,
      rate: config.rate,
      pitch: config.pitch,
      volume: config.volume,
    };
  }

  /** 释放：取消朗读、移除原生监听、清空订阅者。 */
  function destroy() {
    if (destroyed) return;
    destroyImpl();
  }

  function destroyImpl() {
    destroyed = true;
    cancel(); // 内部已包含 clearWatchdog + speechSynthesis.cancel
    stopVoicePolling();
    const synth = getSynth();
    if (synth && nativeVoicesListenerAttached) {
      try {
        synth.removeEventListener?.('voiceschanged', handleNativeVoicesChanged);
      } catch {
        /* 忽略 */
      }
      if (synth.onvoiceschanged === handleNativeVoicesChanged) {
        try { synth.onvoiceschanged = null; } catch { /* 忽略 */ }
      }
      nativeVoicesListenerAttached = false;
    }
    voicesEmitter.clear();
  }

  return {
    speak,
    cancel,
    pause,
    resume,
    isSpeaking,
    isPaused,
    listVoices,
    setVoice,
    setRate,
    setPitch,
    setVolume,
    getConfig,
    onVoicesChanged,
    unlock,
    destroy,
  };
}

/* ========================================================================== *
 * createStt
 * ========================================================================== */

/** 把浏览器语音识别的错误码映射成中文可读信息。 */
const RECOGNITION_ERROR_MESSAGES = {
  'not-allowed': '麦克风权限被拒绝，请在浏览器设置中允许本页面使用麦克风。',
  'service-not-allowed': '浏览器禁止使用语音识别服务，请检查系统或浏览器设置。',
  'no-speech': '没有听到声音，请靠近麦克风后重试。',
  'audio-capture': '未检测到可用的麦克风设备，请检查设备连接与系统权限。',
  network: '语音识别需要网络连接，当前网络不可用。',
  aborted: '语音识别已中止。',
  'language-not-supported': '当前浏览器不支持所选的识别语言。',
  'bad-grammar': '语音识别语法配置不受支持。',
  unsupported: '当前浏览器不支持语音识别，请改用 Chrome / Edge / Safari 等支持 Web Speech API 的浏览器。',
};

/** 错误码 -> 中文信息（未知码回退到原始码文本）。 */
function describeRecognitionError(code) {
  const key = String(code || 'unknown');
  return RECOGNITION_ERROR_MESSAGES[key] || `语音识别出错（${key}）。`;
}

/**
 * 创建语音输入（STT）。
 *
 * @param {object} [options]
 * @param {string} [options.lang='zh-CN']
 * @param {boolean} [options.continuous=true]    连续识别
 * @param {boolean} [options.interimResults=true] 输出中间结果
 * @returns {{
 *   isSupported(): boolean, start(): void, stop(): void, abort(): void,
 *   onResult(cb: Function): Function, onError(cb: Function): Function,
 *   onEnd(cb: Function): Function, destroy(): void
 * }}
 */
export function createStt(options = {}) {
  if (nativeSttAvailable()) return createNativeStt(options);
  // 壳内原生尚未可用时不回退到 Web Speech（WebView 里通常不存在该 API），
  // 直接交由调用方按「不支持」处理。
  if (isNativeShell()) return createNullStt();
  const config = {
    lang: typeof options.lang === 'string' && options.lang ? options.lang : 'zh-CN',
    continuous: options.continuous !== false,
    interimResults: options.interimResults !== false,
  };

  const resultEmitter = createEmitter();
  const errorEmitter = createEmitter();
  const endEmitter = createEmitter();

  let recognition = null;
  let listening = false;     // 期望处于监听状态（用于判断是否需要重启）
  let aborted = false;       // abort() 之后不得重启
  let destroyed = false;
  let starting = false;

  function getCtor() {
    try {
      if (typeof window === 'undefined') return null;
      return window.SpeechRecognition || window.webkitSpeechRecognition || null;
    } catch {
      return null;
    }
  }

  function isSupported() {
    return typeof getCtor() === 'function';
  }

  function emitError(code, message) {
    errorEmitter.emit({ code: String(code), message: message || describeRecognitionError(code) });
  }

  /** 惰性创建识别实例并绑定回调。 */
  function ensureRecognition() {
    if (recognition || destroyed) return recognition;
    const Ctor = getCtor();
    if (typeof Ctor !== 'function') return null;
    try {
      recognition = new Ctor();
    } catch {
      recognition = null;
      return null;
    }
    recognition.lang = config.lang;
    recognition.continuous = config.continuous;
    recognition.interimResults = config.interimResults;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      if (destroyed) return;
      const results = event?.results;
      if (!results) return;
      for (let i = event.resultIndex ?? 0; i < results.length; i += 1) {
        const result = results[i];
        const text = typeof result?.[0]?.transcript === 'string' ? result[0].transcript : '';
        if (!text) continue;
        resultEmitter.emit({ text, isFinal: result.isFinal === true });
      }
    };

    recognition.onerror = (event) => {
      if (destroyed) return;
      const code = event?.error || 'unknown';
      // aborted 是 stop()/abort() 的正常副作用，不打扰调用方。
      if (code !== 'aborted') emitError(code, describeRecognitionError(code));
      // 致命错误不再自动重启，避免在无权限时无限弹错误。
      if (code === 'not-allowed' || code === 'service-not-allowed' || code === 'audio-capture' || code === 'language-not-supported') {
        listening = false;
      }
    };

    recognition.onend = () => {
      if (destroyed) return;
      starting = false;
      const shouldRestart = listening && !aborted && config.continuous;
      if (!shouldRestart) {
        listening = false;
        endEmitter.emit();
        return;
      }
      // continuous 模式下浏览器仍会自动结束（超时/静音），按需重启。
      // abort() 之后 aborted === true，绝不重启。
      try {
        recognition.start();
      } catch {
        // start() 在极短时间内重复调用会抛 InvalidStateError：稍后重试一次。
        setTimeout(() => {
          if (destroyed || !listening || aborted) return;
          try { recognition?.start(); } catch { listening = false; endEmitter.emit(); }
        }, 220);
      }
    };

    recognition.onstart = () => {
      starting = false;
    };

    return recognition;
  }

  /** 开始识别。不支持时安全 no-op，并通过 onError 回调 unsupported。 */
  function start() {
    if (destroyed) return;
    if (!isSupported()) {
      emitError('unsupported');
      return;
    }
    aborted = false;
    listening = true;
    const instance = ensureRecognition();
    if (!instance) {
      listening = false;
      emitError('unsupported');
      return;
    }
    // 同步刷新配置，允许调用方在 start() 前修改 options 字段。
    instance.lang = config.lang;
    instance.continuous = config.continuous;
    instance.interimResults = config.interimResults;
    if (starting || instance.__fairyListening) return;
    starting = true;
    try {
      instance.start();
      instance.__fairyListening = true;
    } catch {
      // 已在运行（InvalidStateError）：保持 listening 状态即可，不报错。
      starting = false;
    }
  }

  /** 正常结束（会触发最终 onend，不重启）。 */
  function stop() {
    listening = false;
    starting = false;
    if (recognition) {
      recognition.__fairyListening = false;
      try { recognition.stop(); } catch { /* 忽略 */ }
    }
  }

  /** 立即中止（丢弃未完成结果，且**不得**重启）。 */
  function abort() {
    aborted = true;
    listening = false;
    starting = false;
    if (recognition) {
      recognition.__fairyListening = false;
      try { recognition.abort(); } catch { /* 忽略 */ }
    }
  }

  function destroy() {
    if (destroyed) return;
    abort();
    destroyed = true;
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.onstart = null;
      recognition = null;
    }
    resultEmitter.clear();
    errorEmitter.clear();
    endEmitter.clear();
  }

  return {
    isSupported,
    start,
    stop,
    abort,
    onResult: (cb) => resultEmitter.add(cb),
    onError: (cb) => errorEmitter.add(cb),
    onEnd: (cb) => endEmitter.add(cb),
    destroy,
  };
}

export default { createTts, createStt, stripForSpeech, chunkForSpeech, isSpeechSynthesisSupported, isRecognitionSupported };
