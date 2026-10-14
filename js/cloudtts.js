/**
 * cloudtts.js —— 云端语音合成（TTS）客户端
 *
 * 为什么走云 API 而不是本地模型：
 *   本地语音克隆需要 sherpa-onnx 原生库 + ~180MB 模型，实测在部分设备上会
 *   导致启动崩溃，且 Android 限制第三方库无法从包外加载。云 API 完全规避
 *   这些问题，并且支持用一段参考录音克隆出目标音色。
 *
 * 支持的服务：
 *   - SiliconFlow（推荐）：国内可直连，支持上传参考音频克隆音色
 *   - 百度翻译 TTS：免注册、开箱即用（音色固定，不能克隆）
 *   - 自定义：任意 OpenAI 兼容的 /audio/speech 端点
 *
 * 所有请求都在**原生层**发出（见 MainActivity 的 cloudTts* 桥），
 * 而不是在 WebView 里 fetch —— 因为多数语音服务不返回 CORS 头，
 * 浏览器直连会被拦截。原生 HTTP 无此限制。
 */

/* ── 提供商定义 ───────────────────────────────────────── */

export const PROVIDERS = {
  auto: {
    id: 'auto',
    label: '自动选择（推荐）',
    hint: '填了 SiliconFlow Key 就用它，否则用免注册的百度语音',
    needsKey: false,
    supportClone: false,
  },
  siliconflow: {
    id: 'siliconflow',
    label: 'SiliconFlow（支持克隆 Fairy 音色）',
    hint: '在 cloud.siliconflow.cn 注册并实名后可上传参考音频克隆音色',
    needsKey: true,
    supportClone: true,
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'FunAudioLLM/CosyVoice2-0.5B',
  },
  baidu: {
    id: 'baidu',
    label: '百度翻译语音（免注册，音色固定）',
    hint: '开箱即用，但只能用固定音色，不能克隆',
    needsKey: false,
    supportClone: false,
  },
  custom: {
    id: 'custom',
    label: '自定义（OpenAI 兼容 /audio/speech）',
    hint: '可接入任意兼容端点：自建服务、其它云厂商等',
    needsKey: true,
    supportClone: false,
  },
};

export function getProvider(id) {
  return PROVIDERS[id] || PROVIDERS.auto;
}

/**
 * 决定实际使用哪个提供商。
 * auto 的规则：填了 SiliconFlow Key 就用它，否则退回百度。
 */
export function resolveProvider(settings) {
  const wanted = settings.ttsProvider || 'auto';
  if (wanted !== 'auto') return wanted;
  if (String(settings.sfApiKey || '').trim()) return 'siliconflow';
  if (String(settings.customBaseUrl || '').trim()) return 'custom';
  return 'baidu';
}

/* ── 参数组装 ─────────────────────────────────────────── */

/**
 * 把设置转换成原生层需要的合成参数。
 * @returns {{provider:string, baseUrl:string, apiKey:string, model:string,
 *            voice:string, speed:number, format:string}}
 */
export function buildSynthesisParams(settings, providerId) {
  const provider = providerId || resolveProvider(settings);
  const speed = Number(settings.rate) || 1;

  if (provider === 'siliconflow') {
    return {
      provider,
      baseUrl: String(settings.sfBaseUrl || PROVIDERS.siliconflow.baseUrl).replace(/\/+$/, ''),
      apiKey: String(settings.sfApiKey || '').trim(),
      model: String(settings.sfModel || PROVIDERS.siliconflow.model).trim(),
      // 首选克隆音色；没有则退到系统预置音色
      voice: String(settings.sfVoice || '').trim()
        || `${settings.sfModel || PROVIDERS.siliconflow.model}:alex`,
      speed,
      format: 'mp3',
    };
  }

  if (provider === 'custom') {
    return {
      provider,
      baseUrl: String(settings.customBaseUrl || '').replace(/\/+$/, ''),
      apiKey: String(settings.customApiKey || '').trim(),
      model: String(settings.customModel || '').trim(),
      voice: String(settings.customVoice || '').trim(),
      speed,
      format: 'mp3',
    };
  }

  // 百度翻译 TTS：无需 Key，lang 由音色决定
  return {
    provider: 'baidu',
    baseUrl: '',
    apiKey: '',
    model: '',
    voice: String(settings.sfVoice || '').startsWith('en') ? 'en' : 'zh',
    speed,
    format: 'mp3',
  };
}

/* ── 连通性/配置校验 ──────────────────────────────────── */

/**
 * 检查配置是否完整，返回中文提示（空串表示可用）。
 */
export function validateConfig(settings, providerId) {
  const provider = providerId || resolveProvider(settings);
  if (provider === 'baidu') return '';
  if (provider === 'siliconflow') {
    if (!String(settings.sfApiKey || '').trim()) {
      return 'SiliconFlow 需要 API Key，请到 cloud.siliconflow.cn 获取后填入。';
    }
    return '';
  }
  if (provider === 'custom') {
    if (!String(settings.customBaseUrl || '').trim()) {
      return '请填写自定义服务的 Base URL（OpenAI 兼容）。';
    }
    return '';
  }
  return '';
}

/* ── 克隆音色（SiliconFlow）──────────────────────────── */

/**
 * 把参考音频（base64）上传为可复用的音色。
 * 这一步在原生层完成（含文件读取与上传），返回音色 ID。
 *
 * @returns {Promise<string>} 音色 uri
 */
export function cloneVoiceFromAudio({ apiKey, baseUrl, model, name, audioBase64, mimeType, refText }) {
  return cloneViaBridge({ apiKey, baseUrl, model, name, audioBase64, mimeType, refText });
}

/** 通过原生桥执行上传（避免 CORS 与 WebView 内存压力） */
function cloneViaBridge(params) {
  return new Promise((resolve, reject) => {
    const bridge = typeof window !== 'undefined' ? window.AndroidBridge : null;
    if (!bridge || typeof bridge.uploadVoice !== 'function') {
      reject(new Error('当前环境不支持上传音色（需在 APK 内使用）'));
      return;
    }
    // 原生层完成后回调 window.__fairyCloud.onUploadResult
    if (typeof window !== 'undefined') {
      window.__fairyCloud = window.__fairyCloud || {};
      window.__fairyCloud.onUploadResult = (ok, payload) => {
        if (ok) resolve(payload);
        else reject(new Error(payload || '上传失败'));
      };
    }
    try {
      bridge.uploadVoice(
        String(params.apiKey || ''),
        String(params.baseUrl || ''),
        String(params.model || ''),
        String(params.name || 'fairy'),
        String(params.audioBase64 || ''),
        String(params.mimeType || 'audio/wav'),
        String(params.refText || ''),
      );
    } catch (err) {
      reject(new Error(`调用原生上传失败：${err.message}`));
    }
  });
}
