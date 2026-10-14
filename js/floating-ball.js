/**
 * floating-ball.js —— 悬浮球（语音唤醒入口）的前端控制
 *
 * 背景：原先的「后台常驻监听唤醒词」需要一直占用麦克风与一个前台服务，
 * 耗电且被各家 ROM 限制；改为一个可点的悬浮球后：
 *   - 代价低（只是一个窗口）
 *   - 交互明确（不用猜唤醒词有没有被听到）
 *   - 点一下即开始说话
 *
 * 本模块负责设置界面里的开关、权限引导与状态显示；
 * 实际的小球绘制与拖动在原生侧（FloatingBallService）。
 *
 * 同时对外提供 onFloatingBallTap()：原生在用户点击小球后调用它，
 * 用来让页面进入语音输入状态。
 */

import { patchSettings } from './store.js';
import { $, toast } from './ui.js';

const KEY_PREF = 'fairy-mobile:floating-ball';

export function initFloatingBall(ctx) {
  const { getSettings, save, startListening, setStatus } = ctx;

  const toggle = $('#set-float-enabled');
  const statusNode = $('#float-status');
  const permBtn = $('#btn-float-perm');
  const refreshBtn = $('#btn-float-refresh');

  const bridge = () => (typeof window !== 'undefined' ? window.AndroidBridge : null);
  /** 等待权限授予的轮询定时器 */
  let waitTimer = null;

  /** 读取原生状态 */
  function readStatus() {
    const b = bridge();
    if (!b || typeof b.floatingBallStatus !== 'function') {
      return { available: false, reason: '当前环境不支持悬浮球（需在 APK 内使用）' };
    }
    try {
      const raw = JSON.parse(b.floatingBallStatus() || '{}');
      return {
        available: raw.supported === '1',
        permitted: raw.permission === '1',
        running: raw.running === '1',
        status: raw.status || '',
        error: raw.error || '',
        sdk: raw.sdk,
      };
    } catch (err) {
      return { available: false, reason: `读取状态失败：${err.message}` };
    }
  }

  /** 渲染状态说明与按钮可用性 */
  function renderStatus() {
    const st = readStatus();
    if (!st.available) {
      if (statusNode) {
        statusNode.textContent = st.reason || '当前环境不支持悬浮球。';
        statusNode.className = 'field-note bad';
      }
      if (toggle) { toggle.disabled = true; toggle.checked = false; }
      if (permBtn) permBtn.disabled = true;
      return st;
    }

    let text;
    let cls = 'field-note';
    if (!st.permitted) {
      text = '还差一步：需要「显示在其他应用上层」权限。点下方按钮前往系统设置开启。';
      cls = 'field-note bad';
    } else if (st.running) {
      text = '悬浮球正在显示。点小球即可说话；拖到左右边缘会自动收起成半个。';
      cls = 'field-note ok';
    } else if (st.error) {
      // 有明确失败原因时优先显示，这是排障的关键信息
      text = `启动失败：${st.error}`;
      cls = 'field-note bad';
    } else {
      text = '权限已就绪。打开上面的开关即可显示悬浮球。';
    }
    // 附加原生状态原文（含尺寸等信息，便于排查）
    if (st.status && st.running) text += `\n（${st.status}）`;

    if (statusNode) {
      statusNode.textContent = text;
      statusNode.className = cls;
    }
    if (toggle) {
      toggle.disabled = false;
      // 勾选状态 = 服务在跑，或「用户已表达开启意图但尚未成功」。
      // 后者不能显示为未勾选：否则用户勾了之后看到它自己弹回去，
      // 会以为点击没生效（这正是之前反馈的现象）。
      const wantOn = localStorage.getItem(KEY_PREF) === '1';
      toggle.checked = st.running || (wantOn && !st.running && Boolean(st.error));
    }
    if (permBtn) {
      permBtn.disabled = false;
      permBtn.textContent = st.permitted ? '已获权限（可再次查看）' : '授予悬浮窗权限';
    }
    return st;
  }

  /** 开启/关闭浮球 */
  function applyEnabled(enabled) {
    const b = bridge();
    if (!b) {
      toast('当前环境不支持悬浮球。');
      return false;
    }
    if (!enabled) {
      try { b.floatingBallStop?.(); } catch { /* 忽略 */ }
      localStorage.setItem(KEY_PREF, '0');
      setTimeout(renderStatus, 300);
      toast('已关闭悬浮球。');
      return true;
    }

    let result = 'error';
    try { result = b.floatingBallStart?.() ?? 'error'; } catch (err) { result = `error:${err.message}`; }

    const text = String(result || '');

    if (text === '1') {
      localStorage.setItem(KEY_PREF, '1');
      toast('悬浮球已开启。');
      setTimeout(renderStatus, 400);
      return true;
    }

    if (text === 'noperm') {
      // 缺权限：引导用户去授权，并记住「想开启」的意图
      localStorage.setItem(KEY_PREF, '1');
      showFailure('还差一步：需要「显示在其他应用上层」权限。正在打开系统设置…', true);
      toast('需要先授予悬浮窗权限，正在打开系统设置…');
      try { b.floatingBallRequestPermission?.(); } catch { /* 忽略 */ }
      return false;
    }

    // 服务启动失败：把具体原因显示出来，而不是默默把勾选取消掉
    //（早期版本只 toast 一下就 renderStatus，用户看到的是「勾了又自动取消」，
    //  完全不知道原因）
    const reason = text.startsWith('failed:') ? text.slice(7)
      : text.startsWith('error:') ? text.slice(6)
        : text;
    localStorage.setItem(KEY_PREF, '1');   // 保留意图，修好后可直接重试
    showFailure(`开启失败：${reason}`, true);
    toast(`开启失败：${reason}`);
    return false;
  }

  /** 把失败原因写进状态区（比 toast 更持久，便于用户截图反馈） */
  function showFailure(message, bad = true) {
    if (!statusNode) return;
    statusNode.textContent = message;
    statusNode.className = bad ? 'field-note bad' : 'field-note';
  }

  /**
   * 等待用户从系统设置返回并授予权限，然后自动开启。
   *
   * 为什么需要轮询：悬浮窗权限无法用 requestPermissions 申请，
   * 只能跳转到系统设置页；返回后本应用不会收到任何回调，
   * 因此只能定期检查权限是否已到位。
   *
   * 注意：无论从「开关」还是「授予权限按钮」进入授权流程，
   * 都必须走这里 —— 否则用户授权回来发现还得手动再点一次（早期缺陷）。
   */
  function waitForPermissionThenEnable() {
    if (waitTimer) clearInterval(waitTimer);
    let tries = 0;
    waitTimer = setInterval(() => {
      tries += 1;
      const st = renderStatus();
      if (st.permitted) {
        clearInterval(waitTimer);
        waitTimer = null;
        // 用户此前表达过「想开启」的意图 → 自动完成，无需再点
        if (localStorage.getItem(KEY_PREF) === '1' && !st.running) {
          applyEnabled(true);
        }
        return;
      }
      if (tries >= 40) {   // 约 28 秒后放弃
        clearInterval(waitTimer);
        waitTimer = null;
      }
    }, 700);
  }

  /* ── 事件绑定 ── */
  toggle?.addEventListener('change', (e) => {
    const ok = applyEnabled(e.target.checked);
    if (ok) return;

    // 未成功时如何处理勾选状态：
    //   进入授权流程 → **保持勾选**（用户已表达意愿，授权后会自动开启，
    //                  若这里打回勾选，用户从系统设置回来会以为没生效）
    //   其它失败     → 也保持勾选，但状态区已写明原因，便于用户重试或反馈
    const waitingPermission = localStorage.getItem(KEY_PREF) === '1';
    if (waitingPermission) {
      e.target.checked = true;
      waitForPermissionThenEnable();
    } else {
      e.target.checked = false;
    }
  });

  permBtn?.addEventListener('click', () => {
    const b = bridge();
    if (!b) { toast('当前环境不支持。'); return; }
    try { b.floatingBallRequestPermission?.(); } catch { /* 忽略 */ }
    toast('请在系统设置里允许「显示在其他应用上层」，然后回到这里。');
    waitForPermissionThenEnable();
  });

  refreshBtn?.addEventListener('click', () => {
    const st = renderStatus();
    if (st.available) toast(st.running ? '悬浮球正在显示。' : '悬浮球当前未显示。');
  });

  /* ── 启动时按记忆恢复 ── */
  const st = renderStatus();
  if (st.available && st.permitted && !st.running && localStorage.getItem(KEY_PREF) === '1') {
    // 用户上次开着，但服务没起来（如被系统回收 / 重启过）
    setTimeout(() => applyEnabled(true), 600);
  }

  /* ── 接收原生「小球被点击」的通知 ── */
  if (typeof window !== 'undefined') {
    window.__fairyVoice = window.__fairyVoice || {};
    const prev = window.__fairyVoice.onFloatingBallTap;
    window.__fairyVoice.onFloatingBallTap = () => {
      if (typeof prev === 'function') {
        try { prev(); } catch { /* 忽略 */ }
      }
      handleBallTap({ startListening, setStatus });
    };
  }

  return { renderStatus };
}

/**
 * 用户点了悬浮球：直接进入语音输入。
 * 页面可能刚从后台被拉起，这里等一小会儿确保 DOM 就绪。
 */
function handleBallTap({ startListening, setStatus }) {
  const attempt = (tries) => {
    const mic = document.querySelector('#btn-mic');
    if (!mic || mic.hidden) {
      if (tries < 12) {
        setTimeout(() => attempt(tries + 1), 250);
      } else {
        if (typeof setStatus === 'function') {
          setStatus('此设备没有可用的语音输入。', 'error');
        }
      }
      return;
    }
    if (typeof setStatus === 'function') setStatus('来自悬浮球：正在聆听…');
    try {
      startListening();
    } catch (err) {
      if (typeof setStatus === 'function') setStatus(`语音输入启动失败：${err.message}`, 'error');
    }
  };
  attempt(0);
}
