// 验证 speech.js 的原生桥后端（模拟 Android WebView 的 AndroidBridge）
// 用法：node test/native-bridge.mjs
//
// 桥接约定：原生侧所有返回值都用字符串（"1"/"0"），因为 @JavascriptInterface
// 对 Boolean 等装箱类型支持不可靠，返回 boolean 可能让调用整体失败。
let ttsReady = true;
const calls = { speak: [], stop: 0, start: 0, setRate: [], setPitch: [] };

const bridge = {
  ttsSupported: () => (ttsReady ? '1' : '0'),
  ttsSpeak: (t) => calls.speak.push(t),
  ttsStop: () => { calls.stop += 1; },
  ttsSetRate: (r) => calls.setRate.push(r),
  ttsSetPitch: (p) => calls.setPitch.push(p),
  ttsIsSpeaking: () => '0',
  ttsListVoices: () => JSON.stringify([{ uri: 'v1', name: '中文', lang: 'zh-CN', local: true }]),
  ttsSetVoice: () => {},
  sttSupported: () => '1',
  sttStart: () => { calls.start += 1; },
  sttStop: () => {},
  sttCancel: () => {},
};

globalThis.window = { AndroidBridge: bridge };

const m = await import('../js/speech.js');
const assert = (cond, msg) => { if (!cond) throw new Error(msg); console.log('  ✓ ' + msg); };

console.log('原生桥后端契约');

assert(m.isSpeechSynthesisSupported() === true, '原生 TTS 被识别为可用');
assert(m.isRecognitionSupported() === true, '原生 STT 被识别为可用');

// TTS
const tts = m.createTts({ rate: 1.2, pitch: 0.8 });
assert(typeof tts.speak === 'function', 'createTts 返回原生适配器');
assert(tts.listVoices().length === 1 && tts.listVoices()[0].name === '中文', 'listVoices 返回原生语音列表');
tts.setRate(1.5); tts.setPitch(0.9);
assert(calls.setRate.includes(1.5) && calls.setPitch.includes(0.9), 'setRate/setPitch 转发到原生');

// speak → 原生 onTtsEnd 应 resolve Promise
let ended = false;
let started = false;
const p = tts.speak('你好', {
  onStart: () => { started = true; },
  onEnd: () => { ended = true; },
});
assert(calls.speak[0] === '你好', 'speak 转发文本到原生');
assert(window.__fairyVoice && typeof window.__fairyVoice.onTtsEnd === 'function', '原生钩子已安装');
window.__fairyVoice.onTtsStart();
window.__fairyVoice.onTtsEnd();
await p;
assert(started && ended, 'onStart/onEnd 经原生钩子回传并 resolve');

// STT
const stt = m.createStt({ lang: 'zh-CN', continuous: false, interimResults: true });
let resultText = '';
let resultFinal = null;
let sttEnded = false;
stt.onResult(({ text, isFinal }) => { resultText += text; resultFinal = isFinal; });
stt.onEnd(() => { sttEnded = true; });
stt.start();
assert(calls.start === 1, 'stt.start 转发到原生');
window.__fairyVoice.onSttResult('测试', false);
assert(resultText === '测试' && resultFinal === false, '部分结果回传');
window.__fairyVoice.onSttResult('测试完毕', true);
await new Promise((r) => setTimeout(r, 0));
assert(resultText === '测试测试完毕', '最终结果回传（continuous=false 时结束）');
assert(sttEnded === true, 'continuous=false 时 onEnd 触发');
stt.destroy();

// continuous=true 会续听
const callsBefore = calls.start;
const stt2 = m.createStt({ continuous: true });
let ended2 = false;
stt2.onEnd(() => { ended2 = true; });
stt2.start();
window.__fairyVoice.onSttResult('一段', true);
await new Promise((r) => setTimeout(r, 250)); // 等 160ms 的续听延迟
assert(calls.start > callsBefore, 'continuous=true 时最终结果后自动续听');
assert(ended2 === false, 'continuous 续听期间不触发 onEnd');
stt2.stop();
stt2.destroy();

// ── 异步就绪：这是「此环境不支持语音朗读」的根因场景
console.log('\nTTS 异步就绪（关键回归）');

// 重新模拟一个「启动时还没就绪」的原生环境
ttsReady = false;
const readyCalls = [];
const off = m.onNativeTtsReady((ok) => readyCalls.push(ok));
await new Promise((r) => setTimeout(r, 10));
assert(readyCalls[0] === false, '未就绪时 onNativeTtsReady 回调 false');
assert(m.nativeTtsReady() === false, '未就绪期间 nativeTtsReady() 为 false');
// 壳内即便未就绪也应报「可用」，由调用方用占位实例等待，避免误判为不支持
assert(m.isNativeShell() === true, '识别为运行在原生壳内');
assert(m.isSpeechSynthesisSupported() === true, '壳内视为可用（交由占位实例等待）');
// 此时 createTts 必须返回占位实现，绝不能回退到 Web Speech
const pending = m.createTts({});
assert(pending.isPlaceholder === true, '未就绪时返回占位 TTS（不回退 Web Speech）');
assert(pending.listVoices().length === 0, '占位 TTS 音色列表为空');
assert(typeof pending.speak === 'function', '占位 TTS 方法齐全且安全');

// 原生就绪 → 应主动通知 JS
ttsReady = true;
window.__fairyVoice.onTtsReady('1');
await new Promise((r) => setTimeout(r, 10));
assert(readyCalls.includes(true), '原生就绪后回调 true');
assert(m.nativeTtsReady() === true, '就绪后 nativeTtsReady() 为 true');
const real = m.createTts({});
assert(real.isPlaceholder !== true, '就绪后创建的是真正的原生实例');
assert(real.listVoices().length === 1, '就绪后能取到原生音色');
off();

console.log('全部通过。');
