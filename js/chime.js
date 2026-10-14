/**
 * chime.js —— 语音播报前的提示音
 *
 * 灵感来自《绝区零》里 Fairy 开口前的电子提示音：短促、清亮、
 * 带一点上行音阶与尾音衰减，像是终端在确认"我要说话了"。
 *
 * ⚠️ 关于素材
 * 这里**不使用游戏内的音频文件**（那是受版权保护的素材）。
 * 全部用 Web Audio 实时合成 —— 音效的风格可以借鉴，采样不能复用。
 *
 * 合成而非使用音频文件的理由：
 *   1. 零体积：不增加 APK 大小（几个振荡器节点而已）
 *   2. 零版权风险：每一个采样点都是当场算出来的
 *   3. 可调：能跟随设置改变音高、音量、时长，也能轻松加新音色
 *   4. 不依赖网络：离线也能响
 *
 * 设计要点：
 *   - 音频上下文必须**在用户手势中创建或恢复**，否则移动端浏览器会静默拒绝
 *   - 音量包络必须做淡入淡出，否则会有"啪"的爆音
 *   - 播报前的提示音要短（<0.4s），否则会拖慢对话节奏
 */

/** 预设音色：每种是一组音符 */
export const CHIME_PRESETS = {
  /** 默认：两声上行短音，清亮、有"待命"感 */
  terminal: {
    id: 'terminal',
    label: '终端提示（默认）',
    notes: [
      { freq: 1046.5, at: 0.000, dur: 0.085, gain: 0.30, type: 'triangle' },  // C6
      { freq: 1568.0, at: 0.075, dur: 0.130, gain: 0.24, type: 'triangle' },  // G6
    ],
  },
  /** 柔和的单音，适合长时间使用不厌烦 */
  soft: {
    id: 'soft',
    label: '柔和单音',
    notes: [
      { freq: 880.0, at: 0.000, dur: 0.170, gain: 0.22, type: 'sine' },
    ],
  },
  /** 三声下行，偏"唤醒/启动"的仪式感 */
  boot: {
    id: 'boot',
    label: '启动音（三声）',
    notes: [
      { freq: 1318.5, at: 0.000, dur: 0.065, gain: 0.24, type: 'triangle' },  // E6
      { freq: 1046.5, at: 0.060, dur: 0.065, gain: 0.26, type: 'triangle' },  // C6
      { freq: 783.99, at: 0.120, dur: 0.130, gain: 0.22, type: 'triangle' },  // G5
    ],
  },
  /** 轻微上扬的两声，更"数据流"一点 */
  data: {
    id: 'data',
    label: '数据流',
    notes: [
      { freq: 1174.7, at: 0.000, dur: 0.050, gain: 0.20, type: 'square' },    // D6
      { freq: 1760.0, at: 0.048, dur: 0.095, gain: 0.15, type: 'square' },    // A6
    ],
  },
  /** 关闭 */
  none: { id: 'none', label: '不播放', notes: [] },
};

export function getChimePreset(id) {
  return CHIME_PRESETS[id] || CHIME_PRESETS.terminal;
}

/**
 * 提示音播放器。
 *
 * 用法：
 *   const chime = createChime();
 *   chime.unlock();          // 在用户手势里调用一次
 *   chime.play('terminal');  // 播放
 */
export function createChime(options = {}) {
  let ctx = null;
  let master = null;
  let unlocked = false;
  /** 记录最近一次播放时间，避免短时间内重复叠加（例如连续多条消息） */
  let lastPlayAt = 0;

  const volume = typeof options.volume === 'number' ? options.volume : 0.7;
  /** 最小播放间隔：语音播报通常是对话驱动的，不会太密 */
  const MIN_GAP_MS = 250;

  function ensureContext() {
    if (ctx) return ctx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    try {
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = Math.max(0, Math.min(1, volume));
      master.connect(ctx.destination);
    } catch (err) {
      console.warn('[fairy] 无法创建音频上下文', err);
      ctx = null;
    }
    return ctx;
  }

  /**
   * 解锁音频。
   * 移动端要求音频上下文由用户手势创建或恢复，否则后续播放会被静默忽略。
   * 在首次点击/触摸时调用即可。
   */
  function unlock() {
    const c = ensureContext();
    if (!c) return false;
    try {
      if (c.state === 'suspended') {
        c.resume().then(() => { unlocked = true; }).catch(() => { });
      } else {
        unlocked = true;
      }
    } catch { /* 忽略 */ }
    return unlocked;
  }

  /**
   * 播放提示音。
   * @param {string} presetId
   * @param {{volume?:number, rate?:number}} opts rate 用于微调音高（0.9–1.1）
   */
  function play(presetId = 'terminal', opts = {}) {
    const preset = getChimePreset(presetId);
    if (!preset.notes.length) return;

    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - lastPlayAt < MIN_GAP_MS) return;
    lastPlayAt = now;

    const c = ensureContext();
    if (!c) return;
    // 被浏览器挂起时尝试恢复；失败也不报错（只是没声音）
    if (c.state === 'suspended') {
      c.resume().catch(() => { });
    }

    const rate = typeof opts.rate === 'number' ? Math.max(0.5, Math.min(2, opts.rate)) : 1;
    const vol = typeof opts.volume === 'number' ? opts.volume : 1;
    const t0 = c.currentTime + 0.001;

    for (const note of preset.notes) {
      try {
        const osc = c.createOscillator();
        const gain = c.createGain();

        osc.type = note.type || 'triangle';
        osc.frequency.setValueAtTime(note.freq * rate, t0 + note.at);

        // 音量包络：短促淡入（避免爆音）→ 指数衰减（自然的"叮"）
        const peak = Math.max(0.0001, note.gain * vol);
        const start = t0 + note.at;
        const end = start + note.dur;

        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(peak, start + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, end);

        osc.connect(gain);
        gain.connect(master);

        osc.start(start);
        osc.stop(end + 0.02);

        // 播放结束即断开，避免节点堆积
        osc.onended = () => {
          try { osc.disconnect(); gain.disconnect(); } catch { /* 忽略 */ }
        };
      } catch (err) {
        // 单个音符失败不影响其余
        console.warn('[fairy] 提示音节点创建失败', err);
      }
    }
  }

  function setVolume(v) {
    if (master) {
      try { master.gain.value = Math.max(0, Math.min(1, v)); } catch { /* 忽略 */ }
    }
  }

  function close() {
    try { if (ctx) ctx.close(); } catch { /* 忽略 */ }
    ctx = null;
    master = null;
  }

  return { unlock, play, setVolume, close, isUnlocked: () => unlocked };
}

/**
 * 生成一段可试听的说明（供设置界面展示各预设的差异）。
 */
export function describePresets() {
  return Object.values(CHIME_PRESETS).map((p) => ({
    id: p.id,
    label: p.label,
    noteCount: p.notes.length,
  }));
}
