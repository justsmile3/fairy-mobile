/**
 * cloudtts-ui.js —— 云语音设置界面
 *
 * 负责「设置 → 语音」里与云端 TTS 相关的绑定：
 *   - 合成方式选择（自动 / SiliconFlow / 百度 / 自定义）
 *   - 各提供商的参数表单
 *   - 用参考录音克隆 Fairy 音色
 *   - 试听与状态提示
 *
 * 从 main.js 拆出来，避免主逻辑继续膨胀。
 */

import {
  PROVIDERS, getProvider, resolveProvider, buildSynthesisParams,
  validateConfig, cloneVoiceFromAudio,
} from './cloudtts.js';
import { patchSettings } from './store.js';
import { $, el, toast } from './ui.js';

/** 供外部读取当前生效的后端描述 */
export function describeBackend(settings) {
  const provider = resolveProvider(settings);
  const hint = validateConfig(settings, provider);
  if (hint) return { provider, ready: false, text: hint };
  const p = getProvider(provider);
  const voice = provider === 'siliconflow'
    ? (settings.sfVoice ? '自定义克隆音色' : '预置音色 alex')
    : '';
  return { provider, ready: true, text: `${p.label}${voice ? ` · ${voice}` : ''}` };
}

/**
 * 绑定设置界面。
 * @param {object} ctx
 * @param {() => object} ctx.getSettings 读取当前设置
 * @param {(patch:object)=>object} ctx.save 保存设置（会同步 UI 与原生）
 * @param {(text:string, opts?:object)=>void} ctx.speak 朗读一段文字
 * @param {() => void} [ctx.onChange] 配置变化后的回调（用于刷新诊断）
 */
export function initCloudTtsUi(ctx) {
  const { getSettings, save, speak, onChange } = ctx;

  /* ── 提供商下拉 ── */
  const providerSelect = $('#set-tts-provider');
  if (providerSelect) {
    providerSelect.innerHTML = '';
    for (const p of Object.values(PROVIDERS)) {
      providerSelect.append(el('option', { value: p.id, text: p.label }));
    }
    providerSelect.addEventListener('change', (e) => {
      save({ ttsProvider: e.target.value });
      syncProviderBoxes();
      if (onChange) onChange();
    });
  }

  /** 根据所选提供商显示/隐藏对应表单，并更新提示 */
  function syncProviderBoxes() {
    const settings = getSettings();
    const chosen = settings.ttsProvider || 'auto';
    const effective = resolveProvider(settings);

    const sfBox = $('#sf-box');
    const customBox = $('#custom-box');

    // SiliconFlow 区块的显示规则：
    //   - 显式选中 siliconflow  → 显示
    //   - auto 且已能解析到它    → 显示
    //   - **已填过 Key 或音色**  → 也显示（用户配过，要能继续编辑）
    // 关键：不能在默认状态下把它藏死，否则用户找不到「上传录音克隆音色」的入口。
    const sfConfigured = Boolean(
      String(settings.sfApiKey || '').trim() || String(settings.sfVoice || '').trim(),
    );
    if (sfBox) {
      sfBox.hidden = !(chosen === 'siliconflow'
        || (chosen === 'auto' && effective === 'siliconflow')
        || sfConfigured);
    }
    if (customBox) customBox.hidden = chosen !== 'custom';

    const hint = $('#provider-hint');
    if (hint) {
      const p = getProvider(chosen);
      let text = p.hint;
      if (chosen === 'auto') {
        if (effective === 'siliconflow') {
          text += '（当前会使用：SiliconFlow）';
        } else {
          // 明确指出「想用 Fairy 音色该怎么做」，而不是让用户自己猜
          text += '（当前会使用：百度翻译语音）\n'
            + '💡 想用 Fairy 本人的音色？在上方选「SiliconFlow」，'
            + '填入 API Key 后即可上传录音克隆。';
        }
      }
      const problem = validateConfig(settings, effective);
      hint.textContent = problem ? `${text}\n⚠ ${problem}` : text;
      hint.className = problem ? 'field-note bad' : 'field-note';
    }
    syncTestButton();
  }

  /** 试听按钮的文案随后端变化 */
  function syncTestButton() {
    const btn = $('#btn-test-sf');
    if (!btn) return;
    const settings = getSettings();
    const { ready } = describeBackend(settings);
    btn.textContent = ready ? '测试云语音' : '测试云语音（未配置）';
  }

  /* ── SiliconFlow 参数 ── */
  bindText('#set-sf-key', 'sfApiKey', save, syncProviderBoxes);
  bindText('#set-sf-voice', 'sfVoice', save, syncProviderBoxes);
  bindText('#set-sf-reftext', 'sfRefText', save, null);
  const sfModel = $('#set-sf-model');
  if (sfModel) {
    sfModel.addEventListener('change', (e) => {
      save({ sfModel: e.target.value });
      syncProviderBoxes();
    });
  }

  /* ── 自定义服务参数 ── */
  bindText('#set-custom-url', 'customBaseUrl', save, onChange);
  bindText('#set-custom-key', 'customApiKey', save, onChange);
  bindText('#set-custom-model', 'customModel', save, onChange);
  bindText('#set-custom-voice', 'customVoice', save, onChange);

  /* ── 测试云语音 ── */
  $('#btn-test-sf')?.addEventListener('click', () => {
    const settings = getSettings();
    const provider = resolveProvider(settings);
    const problem = validateConfig(settings, provider);
    if (problem) {
      toast(problem);
      return;
    }
    toast(`正在用「${getProvider(provider).label}」合成…`);
    speak('语音通道测试，我是 Fairy。');
  });

  /* ── 克隆音色 ── */
  const cloneBtn = $('#btn-clone-voice');
  const cloneFile = $('#clone-audio-file');
  const cloneHint = $('#clone-hint');
  const cloneTopBtn = $('#btn-clone-top');
  const cloneTopHint = $('#clone-top-hint');

  /**
   * 统一的克隆入口：
   *   1. 没有 API Key → 自动切到 SiliconFlow 并把焦点移到 Key 输入框
   *   2. 没有参考文本 → 聚焦到文本输入框
   *   3. 都齐了 → 打开文件选择器
   * 这样用户无论从哪个按钮点进来，都会被引导到「差什么补什么」。
   */
  function beginCloneFlow(fromTop) {
    const settings = getSettings();
    const hintNode = fromTop ? cloneTopHint : cloneHint;
    const setHint = (text, kind) => {
      if (hintNode) {
        hintNode.textContent = text;
        hintNode.className = kind ? `field-note ${kind}` : 'field-note';
      }
      if (fromTop && cloneHint) {
        cloneHint.textContent = text;
        cloneHint.className = kind ? `field-note ${kind}` : 'field-note';
      }
    };

    if (!String(settings.sfApiKey || '').trim()) {
      // 自动切到 SiliconFlow，让配置区展开
      save({ ttsProvider: 'siliconflow' });
      const sel = $('#set-tts-provider');
      if (sel) sel.value = 'siliconflow';
      syncProviderBoxes();
      setHint('请先在上方填写 SiliconFlow API Key（在 cloud.siliconflow.cn 的控制台创建），'
        + '填好后再点一次「上传录音，克隆 Fairy 音色」。', 'bad');
      const keyBox = $('#set-sf-key');
      if (keyBox) {
        keyBox.focus();
        keyBox.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      toast('请先填写 SiliconFlow API Key');
      return;
    }

    if (!String(settings.sfRefText || '').trim()) {
      setHint('请先填写「参考录音对应的文字」——必须是录音里逐字说的那句话。', 'bad');
      const box = $('#set-sf-reftext');
      if (box) {
        box.focus();
        box.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      toast('请先填写参考录音对应的文字');
      return;
    }

    setHint('请选择 Fairy 的录音文件（5–10 秒，无背景音乐）。');
    cloneFile?.click();
  }

  /**
   * 用**内置的** Fairy 录音直接克隆，不需要用户选文件。
   * 录音随 APK 一起分发（assets/www/voice/fairy-ref.wav），
   * 由原生桥读成 base64 后回传，规避 WebView 读 assets 二进制的限制。
   */
  async function cloneFromBuiltin() {
    const settings = getSettings();
    const setHint = (text, kind) => {
      const cls = kind ? `field-note ${kind}` : 'field-note';
      if (cloneTopHint) { cloneTopHint.textContent = text; cloneTopHint.className = cls; }
      if (cloneHint) { cloneHint.textContent = text; cloneHint.className = cls; }
    };

    if (!String(settings.sfApiKey || '').trim()) {
      save({ ttsProvider: 'siliconflow' });
      const sel = $('#set-tts-provider');
      if (sel) sel.value = 'siliconflow';
      syncProviderBoxes();
      setHint('还差一步：请先在上方填写 SiliconFlow API Key（cloud.siliconflow.cn 控制台创建），'
        + '填好后再次点击即可一键克隆。', 'bad');
      const keyBox = $('#set-sf-key');
      if (keyBox) {
        keyBox.focus();
        keyBox.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      toast('请先填写 SiliconFlow API Key');
      return;
    }

    const bridge = typeof window !== 'undefined' ? window.AndroidBridge : null;
    if (!bridge || typeof bridge.readBuiltinVoice !== 'function') {
      setHint('当前环境读取不到内置录音，请改用「上传录音」按钮手动选择文件。', 'bad');
      return;
    }

    setHint('正在读取内置的 Fairy 录音…');
    let info;
    try {
      info = JSON.parse(bridge.readBuiltinVoice() || '{}');
    } catch (err) {
      setHint(`读取内置录音失败：${err.message}`, 'bad');
      return;
    }
    if (info.ok !== '1' || !info.base64) {
      setHint(`读取内置录音失败：${info.error || '未知原因'}`, 'bad');
      return;
    }

    // 内置录音配套的参考文本（接口必填）
    const refText = String(info.text || settings.sfRefText || '').trim();
    if (refText) save({ sfRefText: refText });

    setHint(`已读取内置录音（${(Number(info.bytes) / 1024).toFixed(0)} KB），正在上传克隆…`
      + '\n通常需要几秒到几十秒，请勿关闭页面。');

    try {
      const uri = await cloneVoiceFromAudio({
        apiKey: settings.sfApiKey,
        baseUrl: settings.sfBaseUrl || PROVIDERS.siliconflow.baseUrl,
        model: settings.sfModel || PROVIDERS.siliconflow.model,
        name: 'fairy',
        audioBase64: info.base64,
        mimeType: info.mime || 'audio/wav',
        refText,
      });
      save({ sfVoice: uri, ttsProvider: 'siliconflow' });
      const sel = $('#set-tts-provider');
      if (sel) sel.value = 'siliconflow';
      syncProviderBoxes();
      setHint(`✅ 克隆成功！音色 ID：${uri}\n已自动填入，现在朗读就会用 Fairy 的声音。`, 'ok');
      toast('Fairy 音色克隆成功。');
      setTimeout(() => speak('音色校准完成，主人。'), 500);
    } catch (err) {
      setHint(`克隆失败：${err.message}`, 'bad');
      toast(`克隆失败：${err.message}`);
    }
  }

  cloneTopBtn?.addEventListener('click', () => cloneFromBuiltin());
  cloneBtn?.addEventListener('click', () => beginCloneFlow(false));

  cloneFile?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const setHint = (text, kind) => {
      const cls = kind ? `field-note ${kind}` : 'field-note';
      if (cloneHint) { cloneHint.textContent = text; cloneHint.className = cls; }
      if (cloneTopHint) { cloneTopHint.textContent = text; cloneTopHint.className = cls; }
    };
    setHint('正在读取录音…');

    try {
      const base64 = await fileToBase64(file);
      const settings = getSettings();
      const model = settings.sfModel || PROVIDERS.siliconflow.model;
      const refText = String(settings.sfRefText || '').trim();
      setHint(`正在上传「${file.name}」（${(file.size / 1024).toFixed(0)} KB），请稍候…`
        + '\n克隆通常需要几秒到几十秒，请勿关闭页面。');

      const uri = await cloneVoiceFromAudio({
        apiKey: settings.sfApiKey,
        baseUrl: settings.sfBaseUrl || PROVIDERS.siliconflow.baseUrl,
        model,
        name: 'fairy',
        audioBase64: base64,
        mimeType: file.type || guessMime(file.name),
        refText,
      });

      save({ sfVoice: uri, ttsProvider: 'siliconflow' });
      const sel = $('#set-tts-provider');
      if (sel) sel.value = 'siliconflow';
      syncProviderBoxes();
      setHint(`✅ 克隆成功！音色 ID：${uri}\n已自动填入，现在朗读就会用 Fairy 的声音。`, 'ok');
      toast('Fairy 音色克隆成功。');
      // 立刻试听确认
      setTimeout(() => speak('音色校准完成，主人。'), 500);
    } catch (err) {
      setHint(`克隆失败：${err.message}`, 'bad');
      toast(`克隆失败：${err.message}`);
    }
  });

  /* ── 语速 ── */
  const rate = $('#set-rate');
  if (rate) {
    rate.addEventListener('input', (e) => {
      const v = Number(e.target.value);
      const out = $('#out-rate');
      if (out) out.textContent = v.toFixed(1);
      save({ rate: v });
      try { window.AndroidBridge?.ttsSetRate?.(String(v)); } catch { /* 忽略 */ }
    });
  }

  // 关键：初始化时立刻同步一次显示状态。
  // 否则默认 provider 为 auto 时 sf-box 保持 hidden，用户根本看不到克隆入口。
  syncProviderBoxes();

  return { syncProviderBoxes, describeBackend };
}

/* ── 小工具 ───────────────────────────────────────────── */

/** 把一个输入框绑定到某个设置项 */
function bindText(selector, key, save, after) {
  const node = $(selector);
  if (!node) return;
  node.addEventListener('input', (e) => {
    save({ [key]: e.target.value.trim() });
    if (after) after();
  });
}

/** 文件 → base64（不含 data URI 前缀） */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

/**
 * 推断 MIME 类型。
 * 有些来源的文件 file.type 为空，此时按扩展名判断——类型错误会导致服务端拒收。
 */
function guessMime(name) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'wav') return 'audio/wav';
  if (ext === 'm4a') return 'audio/mp4';
  if (ext === 'aac') return 'audio/aac';
  if (ext === 'ogg') return 'audio/ogg';
  if (ext === 'flac') return 'audio/flac';
  if (ext === 'webm') return 'audio/webm';
  return 'audio/wav';
}
