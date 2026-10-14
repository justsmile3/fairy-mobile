/**
 * search-ui.js —— 联网搜索的设置界面
 *
 * 与 cloudtts-ui.js 同样的分工：把「设置 → 联网搜索」这一块的
 * 绑定逻辑独立出来，避免 main.js 继续膨胀。
 */

import { SEARCH_ENGINES, getEngine, search, shouldSearch, buildQuery } from './search.js';
import { $, toast } from './ui.js';

/**
 * 绑定联网搜索设置。
 * @param {object} ctx
 * @param {() => object} ctx.getSettings
 * @param {(patch:object)=>object} ctx.save
 */
export function initSearchUi(ctx) {
  const { getSettings, save } = ctx;

  const toggle = $('#set-search-enabled');
  const engineSel = $('#set-search-engine');
  const countSel = $('#set-search-count');
  const testBtn = $('#btn-search-test');
  const statusNode = $('#search-status');

  const bridge = () => (typeof window !== 'undefined' ? window.AndroidBridge : null);

  function setStatus(text, kind) {
    if (!statusNode) return;
    statusNode.textContent = text || '';
    statusNode.className = kind ? `field-note ${kind}` : 'field-note';
  }

  /* ── 下拉选项 ── */
  if (engineSel && !engineSel.options.length) {
    for (const e of Object.values(SEARCH_ENGINES)) {
      engineSel.append(new Option(e.label, e.id));
    }
  }

  /* ── 同步界面 ── */
  function syncUi() {
    const s = getSettings();
    if (toggle) toggle.checked = s.searchEnabled !== false;
    if (engineSel) engineSel.value = s.searchEngine || 'bing';
    if (countSel) countSel.value = String(s.searchCount || 5);

    // 环境不支持时明确说明，而不是让开关点了没反应
    const b = bridge();
    const usable = Boolean(b && typeof b.searchWeb === 'function');
    if (!usable) {
      setStatus('当前环境不支持联网搜索（需在 APK 内使用）。', 'bad');
      if (toggle) toggle.disabled = true;
      if (testBtn) testBtn.disabled = true;
      return;
    }
    if (s.searchEnabled === false) {
      setStatus('已关闭。涉及实时信息时她只会基于已有知识回答。');
    } else {
      setStatus(`已开启，使用「${getEngine(s.searchEngine).label}」。`);
    }
    if (toggle) toggle.disabled = false;
    if (testBtn) testBtn.disabled = false;
  }

  /* ── 事件 ── */
  toggle?.addEventListener('change', (e) => {
    save({ searchEnabled: e.target.checked });
    syncUi();
    toast(e.target.checked ? '已开启联网搜索。' : '已关闭联网搜索。');
  });

  engineSel?.addEventListener('change', (e) => {
    save({ searchEngine: e.target.value });
    syncUi();
  });

  countSel?.addEventListener('change', (e) => {
    save({ searchCount: Number(e.target.value) });
    syncUi();
  });

  /* ── 测试搜索 ── */
  testBtn?.addEventListener('click', async () => {
    const s = getSettings();
    const q = '今天有什么新闻';
    setStatus(`正在用「${getEngine(s.searchEngine).label}」检索「${q}」…`);
    testBtn.disabled = true;
    try {
      const r = await search(q, {
        engine: s.searchEngine || 'bing',
        count: Number(s.searchCount) || 5,
      });
      if (r.ok) {
        const first = r.results[0] || {};
        setStatus(
          `✓ 成功获取 ${r.results.length} 条结果\n`
          + `示例：${String(first.title || '').slice(0, 50)}\n`
          + `${String(first.snippet || '').slice(0, 80)}`,
          'ok',
        );
      } else {
        setStatus(`✗ 搜索失败：${r.error || '未知原因'}\n`
          + '可尝试切换搜索引擎；若都不行，可能是网络或站点结构变化。', 'bad');
      }
    } catch (err) {
      setStatus(`✗ 搜索异常：${err.message}`, 'bad');
    } finally {
      testBtn.disabled = false;
    }
  });

  syncUi();
  return { syncUi };
}

/** 供诊断面板展示当前搜索状态 */
export function describeSearchState(settings) {
  if (settings.searchEnabled === false) return '已关闭';
  return `已开启（${getEngine(settings.searchEngine).label}）`;
}

export { shouldSearch, buildQuery };
