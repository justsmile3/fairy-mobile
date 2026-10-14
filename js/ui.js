/**
 * ui.js —— 通用 DOM 与交互小工具
 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** 创建元素：el('div', { class:'x', onclick: fn }, [children]) */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/* ── Toast ────────────────────────────────────────────── */

let toastTimer = null;

export function toast(message, ms = 2200) {
  const node = $('#toast');
  if (!node) return;
  node.textContent = message;
  node.dataset.show = 'true';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.dataset.show = 'false'; }, ms);
}

/* ── 确认框 ───────────────────────────────────────────── */

export function confirmDialog(message, { yes = '确定', no = '取消' } = {}) {
  return new Promise((resolve) => {
    const root = $('#confirm');
    const text = $('#confirm-text', root);
    const btnYes = $('#confirm-yes', root);
    const btnNo = $('#confirm-no', root);
    text.textContent = message;
    btnYes.textContent = yes;
    btnNo.textContent = no;
    root.hidden = false;

    const cleanup = (result) => {
      root.hidden = true;
      btnYes.removeEventListener('click', onYes);
      btnNo.removeEventListener('click', onNo);
      root.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onYes = () => cleanup(true);
    const onNo = () => cleanup(false);
    const onBackdrop = (e) => { if (e.target === root) cleanup(false); };
    const onKey = (e) => { if (e.key === 'Escape') cleanup(false); };

    btnYes.addEventListener('click', onYes);
    btnNo.addEventListener('click', onNo);
    root.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
  });
}

/* ── 剪贴板（含 iOS 回退） ────────────────────────────── */

export async function copyText(text) {
  const value = String(text ?? '');
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch { /* 落到回退路径 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/* ── 时间格式 ─────────────────────────────────────────── */

export function formatTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const pad = (n) => String(n).padStart(2, '0');
  if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

/** 估算 token 数（中英混排的粗略近似，仅用于界面展示） */
export function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  const cjk = (s.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) || []).length;
  const rest = s.length - cjk;
  return Math.round(cjk * 0.75 + rest / 4);
}

/** 简单防抖 */
export function debounce(fn, wait = 200) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

/** 节流到动画帧：流式渲染时避免每个 token 都重排 */
export function rafThrottle(fn) {
  let scheduled = false;
  let lastArgs = null;
  return (...args) => {
    lastArgs = args;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn(...lastArgs);
    });
  };
}
