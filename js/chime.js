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
  /**
   * 默认：终端确认音。
   *
   * 比纯正弦更像"电子设备"的几个手法：
   *   - 频率滑移（slide）：起音略带音高位移，比固定音高更有机械感
   *   - 泛音层（partial）：叠加一个高八度弱音，产生金属质感
   *   - 极短间隔的双音：形成"确认"而非"提示"的听感
   */
  terminal: {
    id: 'terminal',
    label: '终端提示（默认）',
    notes: [
      {
        freq: 1174.66, at: 0.000, dur: 0.075, gain: 0.26, type: 'triangle',
        slideFrom: 0.94,        // 从低 6% 滑到目标音高
        partial: { ratio: 2, gain: 0.10 },   // 弱高八度，增加金属感
      },
      {
        freq: 1567.98, at: 0.062, dur: 0.155, gain: 0.22, type: 'triangle',
        slideFrom: 0.97,
        partial: { ratio: 2, gain: 0.08 },
        reverb: 0.16,           // 尾部留一点余韵
      },
    ],
  },
  /** 柔和的单音，适合长时间使用不厌烦 */
  soft: {
    id: 'soft',
    label: '柔和单音',
    notes: [
      {
        freq: 880.0, at: 0.000, dur: 0.190, gain: 0.20, type: 'sine',
        slideFrom: 0.96,
        partial: { ratio: 1.5, gain: 0.05 },
      },
    ],
  },
  /** 三声下行，偏"唤醒/启动"的仪式感 */
  boot: {
    id: 'boot',
    label: '启动音（三声）',
    notes: [
      { freq: 1318.51, at: 0.000, dur: 0.060, gain: 0.22, type: 'triangle', slideFrom: 0.95 },
      { freq: 1046.50, at: 0.055, dur: 0.060, gain: 0.24, type: 'triangle', slideFrom: 0.96 },
      {
        freq: 783.99, at: 0.112, dur: 0.170, gain: 0.20, type: 'triangle',
        slideFrom: 0.97, partial: { ratio: 2, gain: 0.07 }, reverb: 0.18,
      },
    ],
  },
  /** 轻微上扬的两声，更"数据流"一点 */
  data: {
    id: 'data',
    label: '数据流',
    notes: [
      {
        freq: 1174.66, at: 0.000, dur: 0.045, gain: 0.17, type: 'square',
        partial: { ratio: 3, gain: 0.05 },
      },
      {
        freq: 1760.0, at: 0.042, dur: 0.085, gain: 0.12, type: 'square',
        partial: { ratio: 2, gain: 0.05 }, reverb: 0.12,
      },
    ],
  },
  /**
   * 更接近游戏内终端音的风格：
   * 更低的基频 + 明显的上滑 + 较长的余韵，听起来更像"系统在回应"。
   */
  hdd: {
    id: 'hdd',
    label: 'HDD 终端（低沉，带余韵）',
    notes: [
      {
        freq: 659.26, at: 0.000, dur: 0.090, gain: 0.24, type: 'triangle',
        slideFrom: 0.88, slideTo: 1.02,       // 明显的上滑，机械感强
        partial: { ratio: 2, gain: 0.12 },
      },
      {
        freq: 987.77, at: 0.080, dur: 0.260, gain: 0.19, type: 'triangle',
        slideFrom: 0.94,
        partial: { ratio: 1.5, gain: 0.09 },
        reverb: 0.30,                          // 更长的尾音
      },
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
  /** 混响输入节点（可能为 null，表示无混响） */
  let reverbNode = null;
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
      // 余韵用的短混响（程序化生成脉冲响应，不依赖任何音频文件）
      reverbNode = buildReverb(ctx);
      if (reverbNode) reverbNode.connect(master);
    } catch (err) {
      console.warn('[fairy] 无法创建音频上下文', err);
      ctx = null;
    }
    return ctx;
  }

  /**
   * 程序化生成一个短混响的**输入节点**。
   *
   * 用卷积混响 + 合成脉冲响应（噪声按指数衰减），形成"金属面板"式的尾音。
   * 这样不必引入任何音频文件，却能让提示音带上游戏内那种空间感。
   * 返回 null 表示创建失败（此时退化为无混响，不影响播放）。
   */
  function buildReverb(audioCtx) {
    try {
      const seconds = 0.5;
      const rate = audioCtx.sampleRate;
      const len = Math.max(1, Math.floor(rate * seconds));
      const impulse = audioCtx.createBuffer(2, len, rate);
      for (let ch = 0; ch < 2; ch += 1) {
        const data = impulse.getChannelData(ch);
        for (let i = 0; i < len; i += 1) {
          const t = i / len;
          data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 3.2);
        }
      }
      const conv = audioCtx.createConvolver();
      conv.buffer = impulse;
      const wet = audioCtx.createGain();
      wet.gain.value = 0.42;
      conv.connect(wet);
      wet.connect(master);
      return conv;          // 输入节点：把带 reverb 参数的声音接到它上面
    } catch (err) {
      return null;
    }
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
        const start = t0 + note.at;
        const end = start + note.dur;
        const peak = Math.max(0.0001, note.gain * vol);

        // 主振荡器
        const osc = c.createOscillator();
        const gain = c.createGain();
        osc.type = note.type || 'triangle';

        const baseFreq = note.freq * rate;
        // 频率滑移：起音偏离基准音高，短促滑到目标频率。
        // 这一点点滑移是"电子设备"听感的关键 —— 固定音高听起来像音阶练习。
        if (note.slideFrom || note.slideTo) {
          const from = baseFreq * (note.slideFrom || 1);
          const to = baseFreq * (note.slideTo || 1);
          osc.frequency.setValueAtTime(from, start);
          osc.frequency.exponentialRampToValueAtTime(
            Math.max(1, to), start + Math.min(0.05, note.dur * 0.7));
        } else {
          osc.frequency.setValueAtTime(baseFreq, start);
        }

        // 音量包络：极短淡入避免爆音，随后指数衰减模拟"叮"
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(peak, start + 0.006);
        gain.gain.exponentialRampToValueAtTime(0.0001, end);

        osc.connect(gain);
        if (note.reverb && reverbNode) {
          // 一部分送混响，一部分保持干声，听感更自然
          const dry = c.createGain();
          dry.gain.value = 1;
          const send = c.createGain();
          send.gain.value = note.reverb * 2.2;
          gain.connect(dry);
          gain.connect(send);
          dry.connect(master);
          send.connect(reverbNode);
        } else {
          gain.connect(master);
        }

        osc.start(start);
        osc.stop(end + 0.02);
        osc.onended = () => {
          try { osc.disconnect(); gain.disconnect(); } catch { /* 忽略 */ }
        };

        // 泛音层：叠加一个高次谐波，产生金属质感。
        // 音量很低（约主音的 1/3），只贡献音色不改变音高。
        if (note.partial) {
          const p = note.partial;
          const pOsc = c.createOscillator();
          const pGain = c.createGain();
          pOsc.type = 'sine';
          pOsc.frequency.setValueAtTime(baseFreq * (p.ratio || 2), start);
          const pPeak = Math.max(0.0001, peak * (p.gain || 0.08));
          pGain.gain.setValueAtTime(0.0001, start);
          pGain.gain.exponentialRampToValueAtTime(pPeak, start + 0.005);
          pGain.gain.exponentialRampToValueAtTime(0.0001, start + note.dur * 0.75);
          pOsc.connect(pGain);
          pGain.connect(master);
          pOsc.start(start);
          pOsc.stop(end + 0.02);
          pOsc.onended = () => {
            try { pOsc.disconnect(); pGain.disconnect(); } catch { /* 忽略 */ }
          };
        }
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
    reverbNode = null;
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
