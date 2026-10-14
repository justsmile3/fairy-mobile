/**
 * store.js —— 本地持久化
 *
 * 分两层：
 *  - IndexedDB：会话与消息（可能很大，突破 localStorage 5MB 限制）
 *  - localStorage：设置项（小、需要同步读取，用于首屏即时应用主题等）
 *
 * IndexedDB 不可用时（隐私模式等）自动降级到 localStorage，功能不丢，只是容量受限。
 */

const DB_NAME = 'fairy-mobile';
const DB_VERSION = 1;
const SETTINGS_KEY = 'fairy-mobile:settings';
const FALLBACK_PREFIX = 'fairy-mobile:fallback:';

/* ── 默认设置 ─────────────────────────────────────────── */

export const DEFAULT_MODELS = ['deepseek-chat', 'deepseek-reasoner'];

export const DEFAULT_SETTINGS = Object.freeze({
  // 接入
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  models: DEFAULT_MODELS,
  // 生成
  temperature: 1,
  maxTokens: 4096,
  showReasoning: true,
  // 人设
  personaEnabled: true,
  owner: '铃',
  ownerCustom: '',
  extraPrompt: '',
  // 语音
  autoRead: false,
  voiceURI: '',
  rate: 1,
  pitch: 1,
  // ── 云端语音合成（TTS）─────────────────────────────
  // provider: 'auto' 自动选择 | 'siliconflow' | 'baidu' | 'custom'
  ttsProvider: 'auto',
  // SiliconFlow（支持用参考录音克隆音色）
  sfApiKey: '',
  sfModel: 'FunAudioLLM/CosyVoice2-0.5B',
  sfVoice: '',            // 克隆得到的音色 ID，形如 speech:xxx:yyy:zzz
  sfBaseUrl: 'https://api.siliconflow.cn/v1',
  // 参考录音里逐字对应的文本。SiliconFlow 的上传接口**必填**此项。
  //
  // 这里刻意留空：本项目不分发音频素材，参考文本取决于使用者自己上传的录音，
  // 因此无法预设。留空时界面会提示使用者填写。
  sfRefText: '',
  // 自定义 OpenAI 兼容服务（可接入任意自建或第三方 TTS）
  customBaseUrl: '',
  customApiKey: '',
  customModel: '',
  customVoice: '',
  // 云语音识别凭据（百度语音开放平台；留空则只用系统识别）
  sttApiKey: '',
  sttSecretKey: '',

  // ── 联网搜索 ────────────────────────────────────────
  // 免密钥：直接抓取公开结果页解析，无需申请 API Key
  searchEnabled: true,
  searchEngine: 'bing',
  searchCount: 5,

  // ── 语音提示音 ──────────────────────────────────────
  // 朗读前先响一声，像终端在确认"我要说话了"
  chimeEnabled: true,
  chimePreset: 'terminal',
  chimeVolume: 0.7,

  // ── 视差背景（HDD 终端风格）────────────────────────
  parallaxEnabled: true,
  // 外观
  theme: 'dark',
  scale: 100,
  animSpeed: 1,
  mascotVisible: true,
  mascotPos: null,
});

/* ── 设置（localStorage） ─────────────────────────────── */

let settingsCache = null;

export function getSettings() {
  if (settingsCache) return settingsCache;
  let stored = {};
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) stored = JSON.parse(raw);
  } catch (err) {
    console.warn('[fairy] 设置读取失败，使用默认值', err);
  }
  settingsCache = { ...DEFAULT_SETTINGS, ...stored };
  return settingsCache;
}

export function patchSettings(patch) {
  const next = { ...getSettings(), ...patch };
  settingsCache = next;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch (err) {
    console.warn('[fairy] 设置写入失败', err);
  }
  return next;
}

/* ── IndexedDB 封装 ───────────────────────────────────── */

let dbPromise = null;
let usingFallback = false;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB 不可用'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) {
        const s = db.createObjectStore('sessions', { keyPath: 'id' });
        s.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('messages')) {
        const m = db.createObjectStore('messages', { keyPath: 'id' });
        m.createIndex('sessionId', 'sessionId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
    req.onblocked = () => reject(new Error('IndexedDB 被其他标签页占用'));
  }).catch((err) => {
    usingFallback = true;
    console.warn('[fairy] IndexedDB 不可用，降级到 localStorage', err);
    return null;
  });
  return dbPromise;
}

export function isUsingFallback() { return usingFallback; }

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    try {
      out = fn(s);
    } catch (err) {
      reject(err);
      return;
    }
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('事务中止'));
  });
}

function reqAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/* ── 降级实现（localStorage） ─────────────────────────── */

const fallback = {
  read(kind) {
    try {
      return JSON.parse(localStorage.getItem(FALLBACK_PREFIX + kind) || '[]');
    } catch { return []; }
  },
  write(kind, rows) {
    try {
      localStorage.setItem(FALLBACK_PREFIX + kind, JSON.stringify(rows));
    } catch (err) {
      throw new Error('本地存储已满，请删除部分会话后重试');
    }
  },
};

/* ── 工具 ─────────────────────────────────────────────── */

export function newId(prefix = 'id') {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function nowIso() { return new Date().toISOString(); }

/* ── 会话 ─────────────────────────────────────────────── */

export async function listSessions() {
  const db = await openDb();
  let rows;
  if (!db) {
    rows = fallback.read('sessions');
  } else {
    rows = await tx(db, 'sessions', 'readonly', (s) => reqAsPromise(s.getAll()));
  }
  return rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function createSession(title = '新的委托') {
  const session = {
    id: newId('s'),
    title,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    model: getSettings().model,
  };
  const db = await openDb();
  if (!db) {
    const rows = fallback.read('sessions');
    rows.push(session);
    fallback.write('sessions', rows);
  } else {
    await tx(db, 'sessions', 'readwrite', (s) => s.put(session));
  }
  return session;
}

export async function updateSession(id, patch) {
  const db = await openDb();
  if (!db) {
    const rows = fallback.read('sessions');
    const i = rows.findIndex((r) => r.id === id);
    if (i < 0) return null;
    rows[i] = { ...rows[i], ...patch, id };
    fallback.write('sessions', rows);
    return rows[i];
  }
  const current = await tx(db, 'sessions', 'readonly', (s) => reqAsPromise(s.get(id)));
  if (!current) return null;
  const next = { ...current, ...patch, id };
  await tx(db, 'sessions', 'readwrite', (s) => s.put(next));
  return next;
}

export async function deleteSession(id) {
  const db = await openDb();
  if (!db) {
    fallback.write('sessions', fallback.read('sessions').filter((r) => r.id !== id));
    fallback.write('messages', fallback.read('messages').filter((r) => r.sessionId !== id));
    return;
  }
  await tx(db, 'messages', 'readwrite', (s) => reqAsPromise(s.index('sessionId').getAllKeys(id)))
    .then((keys) => tx(db, 'messages', 'readwrite', (s) => { keys.forEach((k) => s.delete(k)); }));
  await tx(db, 'sessions', 'readwrite', (s) => s.delete(id));
}

/* ── 消息 ─────────────────────────────────────────────── */

export async function listMessages(sessionId) {
  const db = await openDb();
  let rows;
  if (!db) {
    rows = fallback.read('messages').filter((m) => m.sessionId === sessionId);
  } else {
    rows = await tx(db, 'messages', 'readonly', (s) =>
      reqAsPromise(s.index('sessionId').getAll(sessionId)));
  }
  return rows.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

export async function addMessage(msg) {
  const row = {
    id: msg.id || newId('m'),
    sessionId: msg.sessionId,
    role: msg.role,
    content: msg.content ?? '',
    reasoning: msg.reasoning ?? '',
    seq: msg.seq ?? Date.now(),
    createdAt: msg.createdAt || nowIso(),
    model: msg.model || '',
    usage: msg.usage || null,
    error: msg.error || false,
  };
  const db = await openDb();
  if (!db) {
    const rows = fallback.read('messages');
    rows.push(row);
    fallback.write('messages', rows);
  } else {
    await tx(db, 'messages', 'readwrite', (s) => s.put(row));
  }
  return row;
}

export async function updateMessage(id, patch) {
  const db = await openDb();
  if (!db) {
    const rows = fallback.read('messages');
    const i = rows.findIndex((r) => r.id === id);
    if (i < 0) return null;
    rows[i] = { ...rows[i], ...patch, id };
    fallback.write('messages', rows);
    return rows[i];
  }
  const current = await tx(db, 'messages', 'readonly', (s) => reqAsPromise(s.get(id)));
  if (!current) return null;
  const next = { ...current, ...patch, id };
  await tx(db, 'messages', 'readwrite', (s) => s.put(next));
  return next;
}

export async function deleteMessage(id) {
  const db = await openDb();
  if (!db) {
    fallback.write('messages', fallback.read('messages').filter((r) => r.id !== id));
    return;
  }
  await tx(db, 'messages', 'readwrite', (s) => s.delete(id));
}

/** 删除某条消息之后（含）的所有消息，用于「重新生成」 */
export async function truncateAfter(sessionId, seq) {
  const rows = await listMessages(sessionId);
  const doomed = rows.filter((m) => (m.seq ?? 0) >= seq);
  const db = await openDb();
  if (!db) {
    const keep = new Set(rows.filter((m) => (m.seq ?? 0) < seq).map((m) => m.id));
    fallback.write('messages', fallback.read('messages').filter(
      (m) => m.sessionId !== sessionId || keep.has(m.id)));
    return doomed.length;
  }
  await tx(db, 'messages', 'readwrite', (s) => { doomed.forEach((m) => s.delete(m.id)); });
  return doomed.length;
}

/* ── 导入导出 ─────────────────────────────────────────── */

export async function exportAll() {
  const sessions = await listSessions();
  const messages = [];
  for (const s of sessions) messages.push(...(await listMessages(s.id)));
  return {
    format: 'deepseek-fairy-mobile',
    version: 1,
    exportedAt: nowIso(),
    sessions,
    messages,
  };
}

export async function importAll(payload) {
  if (!payload || !Array.isArray(payload.sessions) || !Array.isArray(payload.messages)) {
    throw new Error('文件格式不正确：缺少 sessions / messages');
  }
  const db = await openDb();
  const sessions = payload.sessions.map((s) => ({ ...s, id: s.id || newId('s') }));
  const messages = payload.messages.map((m) => ({ ...m, id: m.id || newId('m') }));
  if (!db) {
    const existS = fallback.read('sessions');
    const existM = fallback.read('messages');
    const seenS = new Set(existS.map((s) => s.id));
    fallback.write('sessions', existS.concat(sessions.filter((s) => !seenS.has(s.id))));
    fallback.write('messages', existM.concat(messages));
  } else {
    await tx(db, 'sessions', 'readwrite', (s) => { sessions.forEach((r) => s.put(r)); });
    await tx(db, 'messages', 'readwrite', (s) => { messages.forEach((r) => s.put(r)); });
  }
  return { sessions: sessions.length, messages: messages.length };
}

export async function clearAll() {
  const db = await openDb();
  if (!db) {
    localStorage.removeItem(FALLBACK_PREFIX + 'sessions');
    localStorage.removeItem(FALLBACK_PREFIX + 'messages');
    return;
  }
  await tx(db, 'sessions', 'readwrite', (s) => s.clear());
  await tx(db, 'messages', 'readwrite', (s) => s.clear());
}

/** 粗略估算本地占用，用于设置页展示 */
export async function estimateUsage() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      return { usage, quota };
    }
  } catch { /* 忽略 */ }
  return null;
}
