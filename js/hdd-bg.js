/**
 * hdd-bg.js —— 可拖拽的视差背景（HDD 终端风格）
 *
 * 设计目标：让聊天背景不再是一块纯色，而是有纵深、能跟随手势移动的"终端空间"。
 *
 * ⚠️ 关于素材来源
 * 这里**完全不使用任何游戏素材**。背景的每一层都是程序化绘制的：
 * 网格、扫描线、光晕、数据流标记。风格可以借鉴，具体素材不能复用 ——
 * 这正是本项目移除内置录音时遵循的同一条原则。
 *
 * 层次结构（由远及近，拖动时速度递增，形成视差）：
 *   1. 底色渐变      静止
 *   2. 远景网格      0.06×   —— 细密、暗淡
 *   3. 中景网格      0.14×   —— 稍亮，带发光交叉点
 *   4. 数据流标记    0.22×   —— 稀疏的刻度与编号
 *   5. 扫描线        0.00×   —— 静止覆盖，营造 CRT 质感
 *
 * 为什么用 Canvas 而不是 DOM：
 *   网格线数量多（几百条），用 DOM 会产生大量节点与重排；
 *   Canvas 一次绘制，且滚动/拖动时只改变换矩阵，开销极低。
 */

const LAYERS = [
  {
    key: 'grid-far',
    speed: 0.06,
    spacing: 34,
    // 远景网格要非常淡：截图确认过，0.055 在小屏上仍偏亮，会与正文抢注意力
    color: 'rgba(90, 166, 240, 0.030)',
    lineWidth: 1,
    majorEvery: 4,
    majorColor: 'rgba(90, 166, 240, 0.052)',
  },
  {
    key: 'grid-mid',
    speed: 0.14,
    spacing: 88,
    color: 'rgba(120, 180, 255, 0.045)',
    lineWidth: 1,
    majorEvery: 4,
    majorColor: 'rgba(140, 195, 255, 0.085)',
    nodes: true,          // 交叉点画小发光点
  },
  {
    key: 'data',
    speed: 0.22,
    spacing: 220,
    color: 'rgba(150, 200, 255, 0.10)',
    lineWidth: 1,
    ticks: true,          // 画刻度与编号
  },
];

export function createHddBackground(canvas, options = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') {
    return { setTheme() {}, setParallax() {}, destroy() {} };
  }

  const ctx = canvas.getContext('2d');
  const reduced = Boolean(options.reducedMotion);

  let width = 0;
  let height = 0;
  let dpr = 1;

  /** 视差偏移（由手势驱动） */
  let offsetX = 0;
  let offsetY = 0;
  /** 平滑后的偏移，避免手势停止时突兀 */
  let smoothX = 0;
  let smoothY = 0;

  let theme = 'dark';
  let raf = null;
  let alive = true;
  /** 扫描线的相位，让它缓慢下移 */
  let scanPhase = 0;
  /** 用户可调的网格密度与亮度 */
  let density = 1;
  let brightness = 1;
  /**
   * 文字区遮罩强度（0–1）。
   *
   * 作用：背景铺满全屏（视觉上融入），但在**文字所在的区域**压暗网格，
   * 避免"字和线混在一起"影响阅读。观感上像一束探照灯打在内容上 ——
   * 中间干净、四周网格仍可见。
   *
   * 0 表示不做遮罩（网格完整透出），1 表示文字区完全压平。
   */
  let textVeil = 0.72;

  /** 设置文字区遮罩强度 */
  function setTextVeil(v) {
    const n = Number(v);
    textVeil = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.72;
    draw();
  }

  /** 设置网格密度（0.5–2）：大于 1 更密，小于 1 更疏 */
  function setDensity(v) {
    const n = Number(v);
    density = Number.isFinite(n) && n > 0 ? Math.max(0.4, Math.min(2.2, n)) : 1;
    draw();
  }

  /** 设置整体亮度（0.3–1.6）：影响网格线与刻度的不透明度 */
  function setBrightness(v) {
    const n = Number(v);
    brightness = Number.isFinite(n) && n > 0 ? Math.max(0.2, Math.min(1.8, n)) : 1;
    draw();
  }

  /* ── 尺寸 ─────────────────────────────────────────── */

  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);   // 上限 2，避免高分屏过慢
    width = Math.max(1, Math.round(rect.width));
    height = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  /* ── 调色 ─────────────────────────────────────────── */

  function palette() {
    if (theme === 'light') {
      return {
        bgTop: '#eef3f9',
        bgBottom: '#dfe8f2',
        gridBoost: 0.55,     // 浅色主题下网格要更淡
        scanColor: 'rgba(40, 70, 110, 0.045)',
        glow: 'rgba(90, 140, 210, 0.10)',
        text: 'rgba(70, 110, 160, 0.32)',
        // 文字区遮罩用的颜色：取底色中间值，让网格"消失"而不改变明暗
        veilRgb: '232, 240, 248',
      };
    }
    return {
      bgTop: '#0b1017',
      bgBottom: '#0f1720',
      gridBoost: 1,
      scanColor: 'rgba(180, 220, 255, 0.030)',
      glow: 'rgba(90, 166, 240, 0.14)',
      text: 'rgba(150, 200, 255, 0.28)',
      veilRgb: '13, 19, 27',
    };
  }

  /* ── 绘制 ─────────────────────────────────────────── */

  function draw() {
    if (!alive) return;
    const p = palette();

    // 1. 底色渐变
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, p.bgTop);
    grad.addColorStop(1, p.bgBottom);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    // 2. 中央柔光（让立绘所在的区域更亮一点，形成聚焦感）
    const cx = width / 2;
    const cy = height * 0.38;
    const glow = ctx.createRadialGradient(cx, cy, 10, cx, cy, Math.max(width, height) * 0.62);
    glow.addColorStop(0, p.glow);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);

    // 3. 各视差层
    for (const layer of LAYERS) {
      drawGridLayer(layer, p);
    }

    // 4. 扫描线（覆盖全局，营造终端质感）
    drawScanlines(p);

    // 5. 文字区遮罩
    //    目的：背景铺满全屏（视觉融入），但文字所在的中间区域要干净。
    //    必须在网格与扫描线**之后**绘制才能压住它们。
    drawTextVeil(p);

    // 6. 边缘暗角，让内容区域更聚焦
    drawVignette();
  }

  /**
   * 文字区遮罩：用底色的椭圆渐变压掉中间的网格，
   * 使正文区域干净、四周仍保留终端质感。
   *
   * 为什么用椭圆而不是矩形：
   *   矩形的边缘会形成一条生硬的直线，反而更显眼；
   *   椭圆边界柔和，过渡自然，看起来像光照范围而不是"贴了块板子"。
   *
   * 为什么用底色而不是黑色或白色：
   *   用底色才能让网格"消失"而不改变整体明暗，
   *   否则文字区会变成一块突兀的色斑。
   */
  function drawTextVeil(p) {
    if (textVeil <= 0.001) return;

    const cx = width / 2;
    // 略偏上：正文主要集中在屏幕中上部，立绘在右下
    const cy = height * 0.42;
    // 覆盖范围：横向略超出屏宽，纵向覆盖大部分高度
    const rx = width * 0.78;
    const ry = height * 0.46;

    ctx.save();
    // 用变换把圆形径向渐变拉成椭圆
    ctx.translate(cx, cy);
    ctx.scale(1, ry / rx);

    const g = ctx.createRadialGradient(0, 0, rx * 0.30, 0, 0, rx);
    const solid = Math.round(255 * textVeil);
    // 中心：近乎完全遮住网格
    g.addColorStop(0.00, `rgba(${p.veilRgb}, ${(solid / 255).toFixed(3)})`);
    g.addColorStop(0.62, `rgba(${p.veilRgb}, ${((solid * 0.86) / 255).toFixed(3)})`);
    // 外圈：完全不遮，网格完整保留
    g.addColorStop(1.00, `rgba(${p.veilRgb}, 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(-rx, -rx, rx * 2, rx * 2);
    ctx.restore();
  }

  function drawGridLayer(layer, p) {
    // density 只影响间距（越小越密）；brightness 只影响透明度。
    // 两者分开，用户就能"只调亮度不改变结构"。
    const spacing = Math.max(12, layer.spacing / density);
    const ox = smoothX * layer.speed;
    const oy = smoothY * layer.speed;
    const boost = p.gridBoost * brightness;

    // 起点对齐到网格，避免拖动时出现半格
    const startX = -((ox % spacing) + spacing) % spacing;
    const startY = -((oy % spacing) + spacing) % spacing;

    ctx.save();
    ctx.lineWidth = layer.lineWidth;

    // 竖线
    let i = 0;
    for (let x = startX; x < width + spacing; x += spacing, i += 1) {
      const major = layer.majorEvery && i % layer.majorEvery === 0;
      ctx.strokeStyle = major && layer.majorColor ? layer.majorColor : layer.color;
      ctx.globalAlpha = boost;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, height);
      ctx.stroke();
    }

    // 横线
    let j = 0;
    for (let y = startY; y < height + spacing; y += spacing, j += 1) {
      const major = layer.majorEvery && j % layer.majorEvery === 0;
      ctx.strokeStyle = major && layer.majorColor ? layer.majorColor : layer.color;
      ctx.globalAlpha = boost;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(width, Math.round(y) + 0.5);
      ctx.stroke();
    }

    // 交叉点发光（只在中景层，数量可控）
    if (layer.nodes) {
      ctx.globalAlpha = boost * 0.9;
      for (let x = startX; x < width + spacing; x += spacing) {
        for (let y = startY; y < height + spacing; y += spacing) {
          ctx.fillStyle = layer.majorColor || layer.color;
          ctx.beginPath();
          ctx.arc(x, y, 1.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // 刻度与编号（远景层的"数据流"感）
    if (layer.ticks) {
      ctx.globalAlpha = boost * 0.85;
      ctx.fillStyle = p.text;
      ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textBaseline = 'top';
      let n = 0;
      for (let y = startY; y < height + spacing; y += spacing) {
        for (let x = startX; x < width + spacing; x += spacing) {
          // 十字刻度
          ctx.strokeStyle = layer.color;
          ctx.beginPath();
          ctx.moveTo(x - 4, y);
          ctx.lineTo(x + 4, y);
          ctx.moveTo(x, y - 4);
          ctx.lineTo(x, y + 4);
          ctx.stroke();
          // 编号（错开排布，避免过密）
          if (n % 3 === 0) {
            const label = `0x${((n * 37) % 4096).toString(16).toUpperCase().padStart(3, '0')}`;
            ctx.fillText(label, x + 7, y + 4);
          }
          n += 1;
        }
      }
    }

    ctx.restore();
  }

  function drawScanlines(p) {
    // 每 3px 一条极淡的横线；用相位让它缓慢下移，产生"扫描"感。
    // 透明度压得很低：截图确认过，稍高一点就会让正文看起来发虚。
    const step = 3;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.fillStyle = p.scanColor;
    const shift = reduced ? 0 : Math.round(scanPhase) % step;
    for (let y = -step + shift; y < height; y += step) {
      ctx.fillRect(0, y, width, 1);
    }
    ctx.restore();
  }

  function drawVignette() {
    // 四周压暗，中间稍亮 —— 把视觉焦点引向立绘与对话
    const g = ctx.createRadialGradient(
      width / 2, height * 0.42, Math.min(width, height) * 0.32,
      width / 2, height * 0.42, Math.max(width, height) * 0.78,
    );
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, theme === 'light' ? 'rgba(90,120,160,0.10)' : 'rgba(0,0,0,0.34)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);
  }

  /* ── 动画循环 ─────────────────────────────────────── */

  function tick() {
    if (!alive) return;
    raf = requestAnimationFrame(tick);

    // 偏移平滑跟随：手势停止后仍有一点惯性感
    const k = 0.16;
    const dx = offsetX - smoothX;
    const dy = offsetY - smoothY;
    const moving = Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05;
    if (moving) {
      smoothX += dx * k;
      smoothY += dy * k;
    }

    // 扫描线相位
    if (!reduced) scanPhase += 0.22;

    // 只在需要时重绘，静止时不浪费 CPU
    if (moving || !reduced) draw();
    else if (raf) { /* 保持循环以便恢复 */ }
  }

  /* ── 对外接口 ─────────────────────────────────────── */

  function setParallax(x, y) {
    // 限制范围，避免拖太远把网格拖没了
    const maxX = width * 0.55;
    const maxY = height * 0.55;
    offsetX = Math.max(-maxX, Math.min(maxX, x));
    offsetY = Math.max(-maxY, Math.min(maxY, y));
  }

  function setTheme(next) {
    theme = next === 'light' ? 'light' : 'dark';
    draw();
  }

  function start() {
    if (raf == null) tick();
  }

  function stop() {
    if (raf != null) {
      cancelAnimationFrame(raf);
      raf = null;
    }
  }

  function destroy() {
    alive = false;
    stop();
  }

  // 初始化
  resize();
  start();

  const onResize = () => resize();
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);

  return {
    setParallax, setTheme, setDensity, setBrightness, setTextVeil,
    resize, start, stop, destroy,
  };
}
