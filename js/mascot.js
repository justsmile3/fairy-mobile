/* ============================================================================
 * fairy-mobile / js/mascot.js
 *
 * 手机版 DeepSeek Fairy 吉祥物立绘模块（自包含浏览器 ES Module）。
 *
 * 从源插件 Fairy-DSH/fairy-visual 移植：
 *   - mascot-eye-svg.js      → 眼睛立绘（外盘 / 睫毛四角 / 巩膜 / 眼球层 / 瞳孔 / 高光 / 扫描线）
 *   - mascot-effects-svg.js  → 外圈光环线（HALO）与同心脉冲环（PULSE）
 *   - mascot-geometry.js     → 几何常量（此处以纯数据内联，去掉 Node 校验）
 *   - mascot-style.js        → 转写为 css/mascot.css（类名统一 `fairy-mascot-` 前缀）
 *   - mascot-motion-clock.js → 归一化相位 + 动画速率
 *   - mascot-event-scheduler.js → 单活定时任务表（这里改用帧内剩余时间来支持变速）
 *   - mascot-runtime.js      → 只提炼移动端需要的：眨眼 / 视线跟随 / 状态动效 / 生命周期
 *
 * 本文件零依赖：不 import 任何外部包、不联网、不读文件。
 * 顶层不访问 window / document，因此可以在 Node 中直接 import 做语法检查。
 * ========================================================================== */

/* ---------------------------------------------------------------------------
 * 1. 几何常量（源自 mascot-geometry.js，去掉 require 时的有限性校验）
 * ------------------------------------------------------------------------- */
const G = Object.freeze({
  box: 160,                 // SVG 设计尺寸（viewBox 0 0 160 160）
  outerDiscRadius: 68,      // 蓝色外盘半径
  outerStrokeWidth: 1.2,    // 外盘细白描边
  outerHaloRadius: 79,      // 外盘径向光环半径
  scleraRadius: 48,         // 眼白（巩膜）半径
  scleraContactStrokeWidth: 0.8,
  scleraHaloRadius: 56,     // 巩膜径向光晕半径
  pupilRadius: 16,          // 瞳孔半径
  highlightCenter: Object.freeze({ x: 98, y: 100.5 }), // 高光位置（右下方，固定不动）
  highlightRadius: 11,
  highlightHaloRadius: 18,
});

/** 眼白可活动半径 - 瞳孔半径 - 1 的余量：瞳孔最多能偏移多少而不会翻出眼白。 */
const PUPIL_TRAVEL = G.scleraRadius - G.pupilRadius - 1; // 31

/** 高光相对眼球中心的固定偏移（跟随视线一起平移）。 */
const HIGHLIGHT_OFFSET = Object.freeze({
  x: G.highlightCenter.x - G.box / 2,
  y: G.highlightCenter.y - G.box / 2,
});

/** 视线的垂直行程更小：上下方向的视觉位移比左右敏感。 */
const PUPIL_RATIO_Y = 0.62;

/** 各种归一化数值的取值范围，供 setXxx 静默夹取（越界不抛错）。 */
const LIMITS = Object.freeze({
  scale: Object.freeze({ min: 0.5, max: 1.5, fallback: 1 }),
  speed: Object.freeze({ min: 0.5, max: 2, fallback: 1 }),
});

/** 允许的状态；未知状态一律回落到 idle，保证 setState 永不自爆。 */
const STATES = Object.freeze([
  'idle', 'thinking', 'speaking', 'listening', 'happy', 'alert', 'error', 'sleeping',
]);
const STATE_SET = new Set(STATES);

/** 动画时长基准（毫秒速度倍率 1 时）。 */
const TIMING = Object.freeze({
  blinkDuration: 150,   // 一次完整眨眼（闭 + 开）
  blinkMin: 2200,       // 两次眨眼之间的随机间隔下限
  blinkMax: 6400,
  lashCycle: 15000,     // 睫毛旋转一整圈
  rate: 1440,           // 眼球呼吸的归一化周期（源自 motion clock 默认值）
  frameBudget: 1000 / 34, // 空闲时约 34fps 的帧预算；有指针交互时解除限流
});

/* ---------------------------------------------------------------------------
 * 2. 工具函数
 * ------------------------------------------------------------------------- */

/** 夹取到 [min, max]；非有限数返回 fallback。 */
function clampNumber(value, spec) {
  const numeric = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(numeric)) return spec.fallback;
  return Math.min(spec.max, Math.max(spec.min, numeric));
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

/** 高精度单调时间；Node 与浏览器都安全（不去访问 document）。 */
function nowMs() {
  return typeof performance !== 'undefined' && performance && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** 缓出：让视线/眨眼在末段收敛得更柔和。 */
function easeOutCubic(t) {
  const x = clamp(t, 0, 1);
  return 1 - Math.pow(1 - x, 3);
}

/**
 * 保留源运行时的三次贝塞尔缓动（cubic-bezier(.72, 0, .28, 1)）。
 * 用二分法解 x(t)=x 再取 y(t)，让眼球层的呼吸节奏与原立绘一致。
 */
function easeEyePhase(value) {
  const x = clamp(value, 0, 1);
  let low = 0;
  let high = 1;
  for (let i = 0; i < 12; i += 1) {
    const t = (low + high) / 2;
    const xValue = 3 * (1 - t) * (1 - t) * t * 0.72 + 3 * (1 - t) * t * t * 0.28 + t * t * t;
    if (xValue < x) low = t;
    else high = t;
  }
  const t = (low + high) / 2;
  return 3 * (1 - t) * t * t + t * t * t;
}

/** 0→1→0 的三角波，再套用缓动。 */
function pingPong(value) {
  const x = clamp(value, 0, 1);
  return x <= 0.5 ? x * 2 : 2 - x * 2;
}

/* ---------------------------------------------------------------------------
 * 3. SVG 生成（等价改写源素材，去掉模板里的硬编码像素与 glitch 滤镜）
 * ------------------------------------------------------------------------- */

/**
 * 外圈光环：源素材用几百条逐行横线 + 一张亮度遮罩做出光晕。
 * 移动端用同一组确定性正弦参数直接生成路径；这里按亮度分桶后每桶合并成
 * 一条 path（源素材做法），使整块光晕只剩几条路径。
 */
function buildHaloPaths() {
  const buckets = new Map();
  for (let y = -34; y <= 194; y += 1) {
    const t = y + 34;
    const leftWave = (Math.sin(t * 0.082 - 1.1) + 0.55 * Math.sin(t * 0.151 + 2.4) + 1.55) / 3.1;
    const rightWave = (Math.sin(t * 0.097 + 2.2) + 0.5 * Math.sin(t * 0.137 - 1.7) + 1.5) / 3;
    const leftLength = 158 + leftWave * 56;
    const rightLength = 158 + rightWave * 56;
    const brightness = 0.5 + ((leftWave + rightWave) * 0.5) * 0.5;
    const bucket = clamp(Math.round(brightness * 8) / 8, 0.5, 1);
    const key = bucket.toFixed(3);
    if (!buckets.has(key)) buckets.set(key, []);
    const x = 80 - leftLength;
    buckets.get(key).push(
      'M' + x.toFixed(2) + ' ' + (y + 0.25).toFixed(2) + 'h' + (leftLength + rightLength).toFixed(2),
    );
  }
  return Array.from(buckets.entries()).map(function (entry) {
    return '<path d="' + entry[1].join('') + '" fill="none" stroke="currentColor"'
      + ' stroke-width=".62" stroke-linecap="butt" opacity="' + entry[0] + '"/>';
  }).join('');
}

let haloPathsCache = null;
function getHaloPaths() {
  if (haloPathsCache === null) haloPathsCache = buildHaloPaths();
  return haloPathsCache;
}

/**
 * 光环层：独立 viewBox 保持 SVG 视口内的负坐标线不被裁剪。
 * 源素材用 feGaussianBlur 遮罩做衰减，移动端改为径向渐变 + 每行透明度，零滤镜开销。
 */
function buildHaloSvg() {
  return '<svg class="fairy-mascot-svg fairy-mascot-halo-layer" viewBox="-180 -70 520 320"'
    + ' preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
    + '<defs>'
    + '<radialGradient id="fairy-mascot-halo-fade" gradientUnits="userSpaceOnUse" color-interpolation="linearRGB"'
    + ' cx="80" cy="80" r="124">'
    + '<stop offset="0" stop-color="black"/>'
    + '<stop offset=".44" stop-color="black"/>'
    + '<stop offset=".46" stop-color="white" stop-opacity=".30"/>'
    + '<stop offset=".48" stop-color="white"/>'
    + '<stop offset=".56" stop-color="white" stop-opacity=".56"/>'
    + '<stop offset=".71" stop-color="white" stop-opacity=".19"/>'
    + '<stop offset=".89" stop-color="white" stop-opacity=".058"/>'
    + '<stop offset="1" stop-color="white" stop-opacity="0"/>'
    + '</radialGradient>'
    + '<mask id="fairy-mascot-halo-mask" mask-type="luminance" maskUnits="userSpaceOnUse"'
    + ' maskContentUnits="userSpaceOnUse" x="-260" y="-120" width="680" height="440">'
    + '<rect x="-260" y="-120" width="680" height="440" fill="url(#fairy-mascot-halo-fade)"/>'
    + '</mask>'
    + '</defs>'
    + '<g mask="url(#fairy-mascot-halo-mask)">' + getHaloPaths() + '</g>'
    + '</svg>';
}

/**
 * 脉冲层：五层同心描边共享同一个 transform/opacity 时间线。
 * viewBox 放大到 3 倍，让 2.78x 的最大缩放帧始终落在真实 SVG 视口里。
 */
function buildPulseSvg() {
  return '<svg class="fairy-mascot-svg fairy-mascot-pulse-layer" viewBox="-160 -160 480 480"'
    + ' xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="color:#f4fdff">'
    + '<g class="fairy-mascot-lash-pulse" fill="none">'
    + '<g class="fairy-mascot-lash-pulse-wave">'
    + '<circle cx="80" cy="80" r="52" stroke="currentColor" stroke-width="20" stroke-opacity=".05"/>'
    + '<circle cx="80" cy="80" r="52" stroke="currentColor" stroke-width="16" stroke-opacity=".06"/>'
    + '<circle cx="80" cy="80" r="52" stroke="currentColor" stroke-width="12" stroke-opacity=".08"/>'
    + '<circle cx="80" cy="80" r="52" stroke="currentColor" stroke-width="8" stroke-opacity=".10"/>'
    + '<circle cx="80" cy="80" r="52" stroke="currentColor" stroke-width="4.5" stroke-opacity=".09"/>'
    + '</g>'
    + '</g>'
    + '</svg>';
}

/**
 * 立绘主体：忠实保留源素材的图层顺序
 *   外盘光环 → 外盘 → 四角睫毛 → 巩膜(+光晕/接触边) → 眼球层 → 瞳孔 → 高光 → 扫描线
 * 增加两组移动端专用节点：
 *   .fairy-mascot-gaze  视线平移层（瞳孔 + 高光一起动）
 *   .fairy-mascot-lid   上眼睑（纯 transform 动画，非缩放，避免眼白被压成细线）
 */
function buildEyeSvg() {
  const ohr = G.outerHaloRadius;
  const shr = G.scleraHaloRadius;
  const hhr = G.highlightHaloRadius;
  const hx = G.highlightCenter.x;
  const hy = G.highlightCenter.y;
  return ''
    + '<svg class="fairy-mascot-svg fairy-mascot-svg-main" viewBox="0 0 160 160"'
    + ' xmlns="http://www.w3.org/2000/svg" role="presentation" focusable="false">'
    + '<defs>'
    + '<linearGradient id="fairy-mascot-outer-gradient" x1=".2" y1="0" x2=".8" y2="1">'
    + '<stop stop-color="#4053f0"/><stop offset=".54" stop-color="#3045dc"/><stop offset="1" stop-color="#3d50c8"/>'
    + '</linearGradient>'
    + '<radialGradient id="fairy-mascot-sclera-halo" gradientUnits="userSpaceOnUse" cx="80" cy="80" r="' + shr + '" color-interpolation="linearRGB">'
    + '<stop offset=".82" stop-color="#ffffff" stop-opacity="0"/>'
    + '<stop offset=".857" stop-color="#ffffff" stop-opacity=".22"/>'
    + '<stop offset=".875" stop-color="#ffffff" stop-opacity=".28"/>'
    + '<stop offset=".89" stop-color="#ffffff" stop-opacity=".19"/>'
    + '<stop offset=".94" stop-color="#ffffff" stop-opacity=".07"/>'
    + '<stop offset="1" stop-color="#ffffff" stop-opacity="0"/>'
    + '</radialGradient>'
    + '<radialGradient id="fairy-mascot-outer-halo" gradientUnits="userSpaceOnUse" cx="80" cy="80" r="' + ohr + '" color-interpolation="linearRGB">'
    + '<stop offset=".80" stop-color="var(--fairy-mascot-outer-halo-color)" stop-opacity="0"/>'
    + '<stop offset=".84" stop-color="var(--fairy-mascot-outer-halo-color)" stop-opacity=".10"/>'
    + '<stop offset=".861" stop-color="var(--fairy-mascot-outer-halo-color)" stop-opacity=".28"/>'
    + '<stop offset=".90" stop-color="var(--fairy-mascot-outer-halo-color)" stop-opacity=".18"/>'
    + '<stop offset=".95" stop-color="var(--fairy-mascot-outer-halo-color)" stop-opacity=".06"/>'
    + '<stop offset="1" stop-color="var(--fairy-mascot-outer-halo-color)" stop-opacity="0"/>'
    + '</radialGradient>'
    + '<radialGradient id="fairy-mascot-highlight-halo" gradientUnits="userSpaceOnUse" cx="' + hx + '" cy="' + hy + '" r="' + hhr + '" color-interpolation="linearRGB">'
    + '<stop offset=".53" stop-color="#f5f8fd" stop-opacity="0"/>'
    + '<stop offset=".56" stop-color="#f5f8fd" stop-opacity=".16"/>'
    + '<stop offset=".611" stop-color="#f5f8fd" stop-opacity=".43"/>'
    + '<stop offset=".72" stop-color="#f5f8fd" stop-opacity=".19"/>'
    + '<stop offset=".83" stop-color="#f5f8fd" stop-opacity=".055"/>'
    + '<stop offset="1" stop-color="#f5f8fd" stop-opacity="0"/>'
    + '</radialGradient>'
    + '<pattern id="fairy-mascot-lines" width="4" height="4" patternUnits="userSpaceOnUse">'
    + '<rect width="4" height="1" fill="#c9f8ff" opacity=".055"/>'
    + '</pattern>'
    + '<clipPath id="fairy-mascot-disc-clip"><circle cx="80" cy="80" r="' + (G.outerDiscRadius - 1) + '"/></clipPath>'
    + '<clipPath id="fairy-mascot-sclera-clip"><circle cx="80" cy="80" r="' + G.scleraRadius + '"/></clipPath>'
    + '</defs>'
    + '<g class="fairy-mascot-body">'
    + '<circle class="fairy-mascot-outer-halo" cx="80" cy="80" r="' + ohr + '" fill="url(#fairy-mascot-outer-halo)"/>'
    + '<g class="fairy-mascot-signal">'
    + '<g class="fairy-mascot-image">'
    + '<circle class="fairy-mascot-outer-disc" cx="80" cy="80" r="' + G.outerDiscRadius + '" fill="url(#fairy-mascot-outer-gradient)" stroke="#f2fbff" stroke-width="' + G.outerStrokeWidth + '"/>'
    // 四角睫毛：恒速旋转，形成“睫毛/眼睑”的层次
    + '<g class="fairy-mascot-corners" clip-path="url(#fairy-mascot-disc-clip)" fill="#2b3388">'
    + '<circle cx="80" cy="80" r="51.75"/>'
    + '<rect x="37" y="37" width="86" height="86" rx="2" transform="rotate(3 80 80)"/>'
    + '</g>'
    + '<g class="fairy-mascot-eye">'
    + '<g class="fairy-mascot-sclera">'
    + '<circle cx="80" cy="80" r="' + G.scleraRadius + '" fill="#eef0f5"/>'
    + '<circle class="fairy-mascot-sclera-halo" cx="80" cy="80" r="' + shr + '" fill="url(#fairy-mascot-sclera-halo)"/>'
    + '<circle class="fairy-mascot-sclera-contact" cx="80" cy="80" r="' + G.scleraRadius + '" fill="none" stroke="#ffffff" stroke-width="' + G.scleraContactStrokeWidth + '" stroke-opacity=".16"/>'
    + '</g>'
    + '<g class="fairy-mascot-eyeball">'
    + '<circle class="fairy-mascot-layer-three" cx="80" cy="80" r="33" fill="#9daee0"/>'
    + '<circle class="fairy-mascot-layer-two" cx="80" cy="80" r="24.15" fill="#eef0f5"/>'
    + '<circle class="fairy-mascot-layer-two" cx="80" cy="80" r="23.5" fill="#317bcf"/>'
    + '<circle class="fairy-mascot-layer-one" cx="80" cy="80" r="16.6" fill="none" stroke="#f5f8fd" stroke-width=".1"/>'
    // 视线层：瞳孔 + 高光同步平移（高光保持相对瞳孔的固定偏移）
    + '<g class="fairy-mascot-gaze">'
    + '<circle class="fairy-mascot-layer-one" cx="80" cy="80" r="' + G.pupilRadius + '" fill="#3b3d8a"/>'
    + '<g class="fairy-mascot-highlight fairy-mascot-layer-two">'
    + '<circle class="fairy-mascot-highlight-halo" cx="' + hx + '" cy="' + hy + '" r="' + hhr + '" fill="url(#fairy-mascot-highlight-halo)"/>'
    + '<circle class="fairy-mascot-highlight-glow" cx="' + hx + '" cy="' + hy + '" r="' + G.highlightRadius + '" fill="#f5f8fd"/>'
    + '</g>'
    + '</g>'
    // 上眼睑：平时藏在顶部，眨眼时整体下移覆盖眼白（只动 transform）
    + '<g class="fairy-mascot-lid" clip-path="url(#fairy-mascot-sclera-clip)" aria-hidden="true">'
    + '<path class="fairy-mascot-lid-shape" d="M-6 80 A86 86 0 0 1 166 80 Z" fill="#2b3388"/>'
    + '</g>'
    + '</g>'
    + '</g>'
    + '<g clip-path="url(#fairy-mascot-disc-clip)" opacity=".42">'
    + '<rect class="fairy-mascot-scanlines" x="12" y="10" width="136" height="146" fill="url(#fairy-mascot-lines)"/>'
    + '</g>'
    + '</g>'
    + '</g>'
    + '</g>'
    + '</svg>';
}

/** 说话波形：五根竖条，speaking 状态用 CSS 动画做“口型/声波”感。 */
function buildWaveformHtml() {
  let bars = '';
  for (let i = 0; i < 5; i += 1) bars += '<i class="fairy-mascot-wave-bar"></i>';
  return '<div class="fairy-mascot-waveform" aria-hidden="true">' + bars + '</div>';
}

/* ---------------------------------------------------------------------------
 * 4. 样式注入（可选，幂等）
 *
 * 宿主页面（index.html）已经 `<link rel="stylesheet" href="css/mascot.css">`，
 * 此时检测到样式已生效就完全不动作。只有在样式缺失时才注入一次 <link>，
 * 单一来源仍然是 css/mascot.css，JS 里不复制样式。
 * ------------------------------------------------------------------------- */

function ensureStylesheet(doc) {
  if (!doc || typeof doc.createElement !== 'function') return;
  if (doc.querySelector('link[data-fairy-mascot-css="true"]')) return;
  const view = doc.defaultView || null;
  const readStyle = (view && typeof view.getComputedStyle === 'function')
    ? view.getComputedStyle.bind(view)
    : (typeof getComputedStyle === 'function' ? getComputedStyle : null);
  const probeHost = doc.body || doc.documentElement || null;
  let loaded = false;
  if (probeHost && readStyle) {
    // 只做一个廉价的探测：样式表已加载（例如 index.html 的 <link>）就不再注入
    const probe = doc.createElement('span');
    probe.className = 'fairy-mascot-probe';
    try {
      probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:0;height:0;';
      probeHost.appendChild(probe);
      loaded = readStyle(probe).position === 'absolute';
    } catch (error) {
      loaded = false;
    } finally {
      if (probe.parentNode) probe.remove();
    }
  } else {
    return; // 没有可挂载的宿主节点，等容器就绪后自然会有样式
  }
  if (loaded) return;
  let href = 'css/mascot.css';
  try {
    const script = doc.currentScript
      || doc.querySelector('script[src*="mascot.js"]');
    if (script && script.src) href = new URL('mascot.css', new URL('../css/', script.src)).href;
  } catch (error) {
    /* 定位失败就退回相对路径；样式缺失只影响观感，不能影响功能。 */
  }
  const linkHost = doc.head || doc.documentElement;
  if (!linkHost) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.setAttribute('data-fairy-mascot-css', 'true');
  linkHost.appendChild(link);
}

/* ---------------------------------------------------------------------------
 * 5. 事件调度：替代源 mascot-event-scheduler.js
 *
 * 源调度器用 setTimeout；但动画速度是倍率，定时器无法整体加速。
 * 这里改成“帧内剩余时间”表，延迟按帧间隔推进，改速度立刻生效，destroy 时一键清空。
 * ------------------------------------------------------------------------- */

function createTaskScheduler() {
  const tasks = new Map();
  return {
    /** 同名任务只保留最后一个（源调度器的 name 语义）。 */
    schedule(name, callback, delay) {
      tasks.set(name, {
        remaining: Math.max(0, Number(delay) || 0),
        callback,
      });
    },
    cancel(name) {
      tasks.delete(name);
    },
    cancelAll() {
      tasks.clear();
    },
    get size() {
      return tasks.size;
    },
    /** 按帧推进；deltaMs 为真实帧间隔（速度倍率由调用方提前乘入）。 */
    advance(deltaMs) {
      if (!tasks.size || !(deltaMs > 0)) return;
      Array.from(tasks.entries()).forEach(function (entry) {
        const name = entry[0];
        const task = entry[1];
        if (tasks.get(name) !== task) return; // 期间被取消/替换
        task.remaining -= deltaMs;
        if (task.remaining > 0) return;
        tasks.delete(name);
        task.callback();
      });
    },
  };
}

/* ---------------------------------------------------------------------------
 * 6. createMascot：唯一公开入口
 * ------------------------------------------------------------------------- */

/**
 * 在 container 内创建立绘实例。
 *
 * @param {HTMLElement} container 调用方已经定好尺寸的容器（overlay/占位盒）。
 * @param {{theme?: 'dark'|'light', scale?: number, animationSpeed?: number, reducedMotion?: boolean}} [options]
 * @returns {{
 *   setState(state: string): void,
 *   setScale(n: number): void,
 *   setAnimationSpeed(n: number): void,
 *   setTheme(t: 'dark'|'light'): void,
 *   setReducedMotion(b: boolean): void,
 *   getState(): string,
 *   destroy(): void,
 * }}
 */
export function createMascot(container, options = {}) {
  if (!container || typeof container.appendChild !== 'function') {
    throw new Error('createMascot: 需要一个可用的容器元素');
  }
  const doc = container.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc) throw new Error('createMascot: 当前环境没有 document');

  ensureStylesheet(doc);

  /* --------------------------- 内部状态 --------------------------- */
  let destroyed = false;
  let state = 'idle';
  let theme = options.theme === 'light' ? 'light' : 'dark';
  let scale = clampNumber(options.scale, LIMITS.scale);
  let speed = clampNumber(options.animationSpeed, LIMITS.speed);
  let reduceMotion = Boolean(options.reducedMotion);

  const motionQuery = typeof container.ownerDocument !== 'undefined'
    && doc.defaultView && typeof doc.defaultView.matchMedia === 'function'
    ? doc.defaultView.matchMedia('(prefers-reduced-motion: reduce)')
    : null;
  if (motionQuery && motionQuery.matches) reduceMotion = true;

  /* --------------------------- DOM 构建 --------------------------- */
  const root = doc.createElement('div');
  root.className = 'fairy-mascot-root';
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-state', state);
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = buildHaloSvg() + buildPulseSvg() + buildEyeSvg() + buildWaveformHtml();
  container.appendChild(root);

  const refs = {
    eye: root.querySelector('.fairy-mascot-eye'),
    corners: root.querySelector('.fairy-mascot-corners'),
    gaze: root.querySelector('.fairy-mascot-gaze'),
    layers: {
      sclera: root.querySelector('.fairy-mascot-sclera'),
      three: Array.from(root.querySelectorAll('.fairy-mascot-layer-three')),
      two: Array.from(root.querySelectorAll('.fairy-mascot-layer-two')),
      one: Array.from(root.querySelectorAll('.fairy-mascot-layer-one')),
    },
    lid: root.querySelector('.fairy-mascot-lid'),
  };

  /* --------------------------- 视线状态 --------------------------- */
  // gaze = 归一化目标方向（-1..1）；smooth = 缓动后的实际值（避免每秒几十次跳变）
  const gaze = { targetX: 0, targetY: 0, x: 0, y: 0 };
  let pointerActive = false;   // 最近是否有指针交互（决定是否使用游走目标）
  let wanderPhase = Math.random() * Math.PI * 2;
  let wanderX = 0;
  let wanderY = 0;
  let wanderHold = randomBetween(1.9, 4.2); // 游走视线停留时间（秒）
  /* --------------------------- 眨眼状态 --------------------------- */
  let blinkElapsed = -1;
  let blinkTotal = TIMING.blinkDuration; // 减少动效时拉长单次眨眼，避免“啪”一下

  /* --------------------------- 动画时钟 --------------------------- */
  let phase = 0;          // 归一化眼球呼吸相位（对应源 motion clock）
  let lashAngle = 0;      // 睫毛旋转累计角
  let rafId = 0;
  let lastFrame = 0;
  let frameLottery = 0;   // 空闲降帧累加器（约 34fps，省电）
  let lastWrite = {
    lid: '', gaze: '', sclera: '', three: '', two: '', one: '', corners: '', eye: '',
  };

  const scheduler = createTaskScheduler();

  /* --------------------------- 状态写入 --------------------------- */

  function writeVar(key, element, name, value) {
    if (!element || lastWrite[key] === value) return;
    lastWrite[key] = value;
    element.style.setProperty(name, value);
  }

  /** 把 -1..1 的视线映射为瞳孔位移（限制在眼白内，避免翻出眼白）。 */
  function renderGaze() {
    const px = (gaze.x * PUPIL_TRAVEL).toFixed(2);
    const py = (gaze.y * PUPIL_TRAVEL * PUPIL_RATIO_Y).toFixed(2);
    const value = 'translate(' + px + 'px ' + py + 'px)';
    if (lastWrite.gaze !== value) {
      lastWrite.gaze = value;
      if (refs.gaze) refs.gaze.style.transform = value;
    }
    // 极轻微的头部倾斜，让跟随更有生命感（±1.6°）
    const tilt = (gaze.x * 1.6).toFixed(2) + 'deg ' + (-gaze.y * 1.1).toFixed(2) + 'deg';
    writeVar('eye', refs.eye, '--fairy-mascot-eye-tilt', tilt);
  }

  /** 眨眼：0=全开 1=全闭；用 transform 下移眼睑，不缩放眼球。 */
  function renderBlink() {
    let closed = 0;
    if (blinkElapsed >= 0) {
      const t = blinkElapsed / blinkTotal;
      if (t >= 1) {
        blinkElapsed = -1;
        scheduleBlink();
      } else {
        closed = pingPong(t);
        closed = closed * closed * (3 - 2 * closed); // smoothstep，闭眼更干脆
      }
    }
    const translate = (closed * 172).toFixed(2);
    const opacity = closed > 0.001 ? '1' : '0';
    const value = 'translateY(' + translate + 'px)';
    if (lastWrite.lid !== value) {
      lastWrite.lid = value;
      if (refs.lid) refs.lid.style.transform = value;
    }
    if (refs.lid && refs.lid.style.opacity !== opacity) refs.lid.style.opacity = opacity;
  }

  /**
   * 眼球层呼吸：四层由同一个归一化相位驱动，各自带固定超前量，
   * 形成源素材里“由内向外”的错位脉动。
   */
  function renderBreathing() {
    const spec = [
      ['sclera', refs.layers.sclera, 0.985, 0.91, 0],
      ['three', refs.layers.three, 1, 0.90, 45],
      ['two', refs.layers.two, 1, 0.87, 90],
      ['one', refs.layers.one, 1, 0.85, 180],
    ];
    spec.forEach(function (entry) {
      const key = entry[0];
      const targets = Array.isArray(entry[1]) ? entry[1] : (entry[1] ? [entry[1]] : []);
      if (!targets.length) return;
      const progress = easeEyePhase(pingPong(((phase + entry[4] / TIMING.rate) % 1 + 1) % 1));
      const value = 'scale(' + (entry[2] + (entry[3] - entry[2]) * progress).toFixed(5) + ')';
      if (lastWrite[key] === value) return;
      lastWrite[key] = value;
      targets.forEach(function (element) { element.style.transform = value; });
    });
  }

  function renderLashes() {
    const value = 'rotate(' + lashAngle.toFixed(2) + 'deg)';
    if (lastWrite.corners === value) return;
    lastWrite.corners = value;
    if (refs.corners) refs.corners.style.transform = value;
  }

  /* --------------------------- 调度 --------------------------- */

  function scheduleBlink() {
    if (destroyed) return;
    const factor = reduceMotion ? 4.5 : 1;
    scheduler.schedule('blink', function () {
      startBlink();
    }, randomBetween(TIMING.blinkMin, TIMING.blinkMax) * factor / speed);
  }

  function startBlink() {
    if (destroyed) return;
    blinkTotal = reduceMotion ? TIMING.blinkDuration * 3 : TIMING.blinkDuration;
    blinkElapsed = 0;
    const double = !reduceMotion && Math.random() < 0.16; // 偶尔连眨两下
    if (double) scheduler.schedule('blinkAgain', startBlink, blinkTotal + 110);
  }

  function renderAll() {
    renderGaze();
    renderBreathing();
    renderLashes();
    renderBlink();
  }

  /* --------------------------- 主循环 --------------------------- */

  function computeWanderTarget() {
    // 未交互时缓慢游走：两个不同频率的正弦叠加，避免明显的周期感
    wanderPhase += 0.35;
    wanderHold -= 0.35;
    if (wanderHold <= 0) {
      wanderHold = randomBetween(1.9, 4.2);
      wanderX = randomBetween(-0.72, 0.72);
      wanderY = randomBetween(-0.5, 0.5);
    }
    return {
      x: wanderX * 0.85 + Math.sin(wanderPhase * 0.6) * 0.1,
      y: wanderY * 0.85 + Math.cos(wanderPhase * 0.42) * 0.08,
    };
  }

  function tick(timestamp) {
    rafId = 0;
    if (destroyed) return;
    const last = lastFrame || timestamp;
    let delta = timestamp - last;
    lastFrame = timestamp;
    if (delta < 0) delta = 0;
    if (delta > 250) delta = 250; // 后台回前台：丢掉超大间隔，避免动画瞬移
    // 空闲降帧：没有指针交互时约 34fps，明显降低手机功耗；有交互/眨眼时全速
    frameLottery += delta;
    const budget = pointerActive ? 0 : TIMING.frameBudget;
    if (frameLottery < budget) {
      rafId = requestFrame(tick);
      return;
    }
    const elapsed = frameLottery;
    frameLottery = 0;

    const dtSpeed = elapsed * speed;

    // 1) 定时任务（眨眼排期 / 双眨），已按速度倍率推进
    scheduler.advance(dtSpeed);
    if (destroyed) return;

    // 2) 归一化相位与睫毛角度
    phase = (phase + dtSpeed / TIMING.rate) % 1;
    lashAngle = (lashAngle + (dtSpeed / TIMING.lashCycle) * 360) % 360;

    // 3) 眨眼进度
    if (blinkElapsed >= 0) {
      blinkElapsed += elapsed;
      if (blinkElapsed > blinkTotal) blinkElapsed = -1;
    }

    // 4) 视线目标
    if (!pointerActive) {
      const wander = computeWanderTarget();
      gaze.targetX = wander.x;
      gaze.targetY = wander.y;
    }
    const ease = 1 - Math.pow(0.001, elapsed / 1000); // 与帧率无关的指数收敛
    const strength = state === 'sleeping' ? 0.18 : (reduceMotion ? 0.25 : 1);
    gaze.x += (gaze.targetX - gaze.x) * ease * strength;
    gaze.y += (gaze.targetY - gaze.y) * ease * strength;

    renderAll();

    // 5) 是否还需要继续跑：有排期任务、正在眨眼、或视线尚未收敛
    const settled = Math.abs(gaze.targetX - gaze.x) < 0.0015 && Math.abs(gaze.targetY - gaze.y) < 0.0015;
    if (scheduler.size > 0 || blinkElapsed >= 0 || !settled) {
      rafId = requestFrame(tick);
    }
  }

  function requestFrame(callback) {
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
    return setTimeout(function () { callback(nowMs()); }, 16);
  }

  function cancelFrame(id) {
    if (!id) return;
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
    else clearTimeout(id);
  }

  /** 唤醒主循环；已启动时幂等。 */
  function wake() {
    if (destroyed || rafId) return;
    lastFrame = 0;
    rafId = requestFrame(tick);
  }

  /* --------------------------- 指针 / 触摸交互 --------------------------- */

  function applyPointer(clientX, clientY) {
    if (destroyed || !root.isConnected) return;
    const rect = root.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const nx = ((clientX - (rect.left + rect.width / 2)) / (rect.width / 2));
    const ny = ((clientY - (rect.top + rect.height / 2)) / (rect.height / 2));
    gaze.targetX = clamp(nx, -1, 1);
    gaze.targetY = clamp(ny, -1, 1);
    pointerActive = true;
    releasePointerTask();
    wake();
  }

  /** 指针离开/停止触摸一段时间后，交还给自动游走。 */
  function releasePointerTask() {
    scheduler.schedule('releasePointer', function () {
      pointerActive = false;
      wake();
    }, 2200 / speed);
  }

  function onPointerMove(event) {
    // 触摸由 touchmove 单独处理，避免同一帧写两次
    if (event.pointerType === 'touch') return;
    applyPointer(event.clientX, event.clientY);
  }

  function onPointerOut(event) {
    // 鼠标移出窗口（relatedTarget 为空）时立刻交还给自动游走
    if (event.pointerType === 'touch' || event.relatedTarget) return;
    onPointerLeave();
  }

  function onTouchMove(event) {
    const touch = event.touches && event.touches[0];
    if (!touch) return;
    applyPointer(touch.clientX, touch.clientY);
  }

  function onTouchStart(event) {
    const touch = event.touches && event.touches[0];
    if (touch) applyPointer(touch.clientX, touch.clientY);
    else wake();
  }

  function onPointerLeave() {
    pointerActive = false;
    scheduler.cancel('releasePointer');
    wake();
  }

  function onVisibility() {
    if (doc.visibilityState === 'hidden') {
      cancelFrame(rafId);
      rafId = 0;
      return;
    }
    lastFrame = 0;
    wake();
  }

  function onMotionQueryChange() {
    if (motionQuery && motionQuery.matches) {
      reduceMotion = true;
      root.setAttribute('data-reduced-motion', 'true');
    } else if (!externallyReduced) {
      reduceMotion = false;
      root.removeAttribute('data-reduced-motion');
    }
    wake();
  }

  /* --------------------------- 监听绑定 --------------------------- */
  const view = doc.defaultView || null;
  let externallyReduced = false;

  const supportsPointer = view && typeof view.PointerEvent === 'function';
  const canListen = view && typeof view.addEventListener === 'function';

  if (canListen) {
    if (supportsPointer) {
      view.addEventListener('pointermove', onPointerMove, { passive: true });
      view.addEventListener('pointerout', onPointerOut, { passive: true });
    } else {
      view.addEventListener('mousemove', onPointerMove, { passive: true });
      view.addEventListener('mouseleave', onPointerLeave, { passive: true });
    }
    // 触摸事件单独监听：pointermove 在移动端可能被手势吞掉，touchmove 更可靠
    view.addEventListener('touchstart', onTouchStart, { passive: true });
    view.addEventListener('touchmove', onTouchMove, { passive: true });
    view.addEventListener('touchend', onPointerLeave, { passive: true });
    view.addEventListener('touchcancel', onPointerLeave, { passive: true });
  }
  if (doc.addEventListener) doc.addEventListener('visibilitychange', onVisibility);
  if (motionQuery) {
    if (typeof motionQuery.addEventListener === 'function') motionQuery.addEventListener('change', onMotionQueryChange);
    else if (typeof motionQuery.addListener === 'function') motionQuery.addListener(onMotionQueryChange);
  }

  /* --------------------------- 应用初始状态 --------------------------- */
  root.style.setProperty('--fairy-mascot-scale', String(scale));
  root.style.setProperty('--fairy-mascot-speed', String(speed));
  root.style.setProperty('--fairy-mascot-speed-inv', String(1 / speed));
  if (reduceMotion) root.setAttribute('data-reduced-motion', 'true');
  scheduleBlink();
  renderAll();
  wake();

  /* --------------------------- 公开接口 --------------------------- */

  function setState(next) {
    if (destroyed) return; // destroy 之后一律安全 no-op
    const value = STATE_SET.has(next) ? next : next === 'normal' ? 'idle' : 'idle';
    if (value === state) return;
    state = value;
    root.setAttribute('data-state', state);
    // 状态切换会重新触发 CSS 动画，视觉上从该状态的起点开始
    wake();
  }

  function setScale(next) {
    if (destroyed) return;
    scale = clampNumber(next, LIMITS.scale);
    root.style.setProperty('--fairy-mascot-scale', String(scale));
  }

  function setAnimationSpeed(next) {
    if (destroyed) return;
    speed = clampNumber(next, LIMITS.speed);
    root.style.setProperty('--fairy-mascot-speed', String(speed));
    root.style.setProperty('--fairy-mascot-speed-inv', String(1 / speed));
    wake();
  }

  function setTheme(next) {
    if (destroyed) return;
    theme = next === 'light' ? 'light' : 'dark';
    root.setAttribute('data-theme', theme);
  }

  function setReducedMotion(flag) {
    if (destroyed) return;
    externallyReduced = Boolean(flag);
    reduceMotion = externallyReduced || Boolean(motionQuery && motionQuery.matches);
    if (reduceMotion) root.setAttribute('data-reduced-motion', 'true');
    else root.removeAttribute('data-reduced-motion');
    wake();
  }

  function getState() {
    return state;
  }

  /** 移除 DOM、解绑全部监听、清空定时器与 rAF。可重复调用。 */
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    scheduler.cancelAll();
    cancelFrame(rafId);
    rafId = 0;
    if (canListen) {
      if (supportsPointer) {
        view.removeEventListener('pointermove', onPointerMove);
        view.removeEventListener('pointerout', onPointerOut);
      } else {
        view.removeEventListener('mousemove', onPointerMove);
        view.removeEventListener('mouseleave', onPointerLeave);
      }
      view.removeEventListener('touchstart', onTouchStart);
      view.removeEventListener('touchmove', onTouchMove);
      view.removeEventListener('touchend', onPointerLeave);
      view.removeEventListener('touchcancel', onPointerLeave);
    }
    if (doc.removeEventListener) doc.removeEventListener('visibilitychange', onVisibility);
    if (motionQuery) {
      if (typeof motionQuery.removeEventListener === 'function') motionQuery.removeEventListener('change', onMotionQueryChange);
      else if (typeof motionQuery.removeListener === 'function') motionQuery.removeListener(onMotionQueryChange);
    }
    if (root.parentNode) root.parentNode.removeChild(root);
  }

  return {
    setState,
    setScale,
    setAnimationSpeed,
    setTheme,
    setReducedMotion,
    getState,
    destroy,
  };
}

/** 便捷导出：外部想手动控制动画速度时可用（与实例无关的纯函数）。 */
export const MASCOT_STATES = STATES;

export default { createMascot, MASCOT_STATES };
