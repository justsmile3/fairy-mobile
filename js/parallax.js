/**
 * parallax.js —— 手势驱动的视差：拖动背景，立绘以更快速度跟随
 *
 * 效果目标：像在游戏里转动视角 —— 手指在背景上滑动时，
 * 远景几乎不动、中景缓慢移动、立绘明显位移，形成纵深。
 *
 * 关键设计：
 *   1. **不抢滚动**。只有垂直方向明显小于水平方向、且位移超过阈值时才启用视差，
 *      否则正常滚动对话。否则用户会发现列表拖不动了。
 *   2. **松手回弹**。手指松开后偏移平滑回归原位，不留一个歪掉的世界。
 *      这样不需要"保存位置"，也不会有布局状态要维护。
 *   3. **可关闭**。设置里能关掉（有些人就是不想要动效）。
 */

/** 立绘相对背景的位移倍率：背景 1× 时立绘 1.9×，纵深更强 */
const PET_GAIN = 1.9;
/** 判定为"横向拖动"的角度阈值（水平位移需大于垂直位移的这么多倍） */
const HORIZONTAL_RATIO = 1.35;
/** 触发视差的最小位移（px），低于此值视为点击 */
const MIN_TRAVEL = 12;
/** 回弹动画时长（ms） */
const RELEASE_MS = 420;

export function createParallax(options = {}) {
  const surface = options.surface;      // 手势区域（通常是 #messages）
  const background = options.background; // 背景控制器（需有 setParallax）
  const pet = options.pet;              // 立绘元素
  const enabled = options.enabled !== false;

  if (!surface) {
    return { destroy() {}, setEnabled() {}, reset() {} };
  }

  let on = enabled;
  let active = false;      // 是否正在做视差拖动
  let armed = false;       // 手势已开始但尚未判定为视差
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let curX = 0;
  let curY = 0;
  let raf = null;
  let releaseTimer = null;

  function apply() {
    raf = null;
    if (background && typeof background.setParallax === 'function') {
      background.setParallax(curX, curY);
    }
    if (pet) {
      // 立绘位移更大，形成纵深；同时轻微倾斜，增强"空间在转"的感觉。
      //
      // 安全前提：立绘的定位用的是 left/top（见 main.js 的 placeMascot），
      // 且那里会主动把 transform 置为 none，因此这里可以独占 transform，
      // 不会与拖拽定位冲突。
      const tilt = curX * 0.012;
      pet.style.transform =
        `translate3d(${(curX * PET_GAIN).toFixed(2)}px, ${(curY * PET_GAIN * 0.6).toFixed(2)}px, 0)`
        + ` rotate(${tilt.toFixed(3)}deg)`;
    }
  }

  function schedule() {
    if (raf == null) raf = requestAnimationFrame(apply);
  }

  function onPointerDown(e) {
    if (!on) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // 只响应单指
    if (e.isPrimary === false) return;
    armed = true;
    active = false;
    startX = lastX = e.clientX;
    startY = lastY = e.clientY;
  }

  function onPointerMove(e) {
    if (!on || !armed) return;
    lastX = e.clientX;
    lastY = e.clientY;

    const dx = lastX - startX;
    const dy = lastY - startY;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);

    if (!active) {
      // 判定：位移够大，且明显偏横向 —— 否则让列表正常滚动
      if (absX < MIN_TRAVEL && absY < MIN_TRAVEL) return;
      if (absX < absY * HORIZONTAL_RATIO) {
        // 更像垂直滚动，放弃本次视差
        armed = false;
        return;
      }
      active = true;
      surface.classList.add('is-parallaxing');
    }

    if (e.cancelable) e.preventDefault();
    curX = dx;
    curY = dy * 0.35;   // 垂直方向给一点，但明显小于水平
    schedule();
  }

  function onPointerUp() {
    if (!armed) return;
    const wasActive = active;
    armed = false;
    active = false;
    surface.classList.remove('is-parallaxing');
    if (wasActive) release();
  }

  /** 松手后平滑回位 */
  function release() {
    if (releaseTimer) clearTimeout(releaseTimer);
    const fromX = curX;
    const fromY = curY;
    const t0 = performance.now();

    function step(now) {
      const t = Math.min(1, (now - t0) / RELEASE_MS);
      // ease-out cubic
      const k = 1 - Math.pow(1 - t, 3);
      curX = fromX * (1 - k);
      curY = fromY * (1 - k);
      apply();
      if (t < 1) {
        releaseTimer = requestAnimationFrame(step);
      } else {
        curX = 0;
        curY = 0;
        apply();
        // 回位后清掉 transform，交还给布局（立绘位置由 left/top 控制）
        if (pet) pet.style.transform = 'none';
        releaseTimer = null;
      }
    }
    releaseTimer = requestAnimationFrame(step);
  }

  /** 立即回到原位（切换会话、设置变更时用） */
  function reset() {
    if (releaseTimer) {
      cancelAnimationFrame(releaseTimer);
      releaseTimer = null;
    }
    curX = 0;
    curY = 0;
    apply();
    if (pet) pet.style.transform = 'none';
  }

  function setEnabled(next) {
    on = next !== false;
    if (!on) reset();
    surface.classList.toggle('parallax-enabled', on);
  }

  // 用 Pointer Events 统一处理触摸与鼠标
  surface.addEventListener('pointerdown', onPointerDown, { passive: true });
  surface.addEventListener('pointermove', onPointerMove, { passive: false });
  surface.addEventListener('pointerup', onPointerUp, { passive: true });
  surface.addEventListener('pointercancel', onPointerUp, { passive: true });
  // 指针移出区域也要收尾，否则会卡在拖动状态
  surface.addEventListener('pointerleave', onPointerUp, { passive: true });

  surface.classList.toggle('parallax-enabled', on);

  return {
    setEnabled,
    reset,
    isEnabled: () => on,
    destroy() {
      surface.removeEventListener('pointerdown', onPointerDown);
      surface.removeEventListener('pointermove', onPointerMove);
      surface.removeEventListener('pointerup', onPointerUp);
      surface.removeEventListener('pointercancel', onPointerUp);
      surface.removeEventListener('pointerleave', onPointerUp);
      if (releaseTimer) cancelAnimationFrame(releaseTimer);
      if (raf) cancelAnimationFrame(raf);
    },
  };
}
