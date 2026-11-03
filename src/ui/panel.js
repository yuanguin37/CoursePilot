import { APP_NAME, VERSION } from '../version.js';
import { formatClock, formatPercent, formatRate } from '../util.js';
import { PANEL_CSS } from './styles.js';

const PANEL_TABS = ['overview', 'settings', 'logs'];

const TEMPLATE = `
<div class="cp-panel" data-phase="idle" data-folded="false">
  <header class="cp-head" data-role="head">
    <div class="cp-brand">
      <span class="cp-pulse"></span>
      <span class="cp-title" title="${APP_NAME} v${VERSION}">${APP_NAME}</span>
    </div>
    <div class="cp-head-right">
      <span class="cp-badge" data-role="badge">通用网页</span>
      <button class="cp-icon" data-act="fold" title="折叠面板">–</button>
      <button class="cp-icon" data-act="close" title="关闭面板">×</button>
    </div>
  </header>

  <div class="cp-statusline">
    <span class="cp-dot"></span>
    <span class="cp-kind" data-role="kind" hidden>视频</span>
    <span class="cp-status" data-role="status">待机</span>
    <span class="cp-pct" data-role="pct">0.0%</span>
  </div>

  <div class="cp-body">
    <section class="cp-tab" data-panel="overview">
      <div class="cp-progress">
        <div class="cp-track"><div class="cp-fill" data-role="bar"></div></div>
        <div class="cp-progress-meta">
          <span data-role="time">--:-- / --:--</span>
          <span data-role="platform">—</span>
        </div>
      </div>

      <div class="cp-row">
        <button class="cp-btn primary" data-act="toggle" data-role="toggle">暂停托管</button>
        <button class="cp-btn" data-act="next" data-role="nextBtn">下一节</button>
      </div>

      <div class="cp-speed">
        <div class="cp-label-row">
          <span data-role="speedLabel">播放倍速</span>
          <span class="cp-rate-wrap">
            <em class="cp-lock" data-role="lock">突破上限</em>
            <b data-role="rate">4×</b>
          </span>
        </div>
        <input class="cp-range" type="range" min="0.5" max="16" step="0.25" data-role="speed">
        <div class="cp-presets">
          <button data-rate="1">1×</button>
          <button data-rate="1.5">1.5×</button>
          <button data-rate="2">2×</button>
          <button data-rate="3">3×</button>
          <button data-rate="4" class="on">4×</button>
          <button data-rate="5">5×</button>
          <button data-rate="8">8×</button>
          <button data-rate="10">10×</button>
          <button data-rate="16">16×</button>
        </div>
      </div>

      <div class="cp-grid">
        <div class="cp-cell"><span data-role="watchedLabel">已看时长</span><b data-role="watched">0:00</b></div>
        <div class="cp-cell"><span>完成节数</span><b data-role="segments">0</b></div>
        <div class="cp-cell"><span>实际倍率</span><b data-role="effective">—</b></div>
        <div class="cp-cell"><span>累计切换</span><b data-role="switches">0</b></div>
      </div>

      <div class="cp-materials" data-role="outlineRow" hidden>
        <span data-role="outlineText">未完成：—</span>
        <button class="cp-btn sm" data-act="jump" data-role="jumpBtn">跳过去</button>
        <button class="cp-btn sm" data-act="inspect" data-role="inspectBtn" hidden>诊断</button>
      </div>

      <div class="cp-materials" data-role="materials" hidden>
        <span>课件资料 <b data-role="materialCount">0</b> 项 · 阅读即可计入</span>
        <button class="cp-btn sm" data-act="download" title="可选动作，与进度无关">下载资料</button>
      </div>
    </section>

    <section class="cp-tab" data-panel="settings" hidden>
      <label class="cp-switch"><span>突破平台倍速上限</span><input type="checkbox" data-key="breakthrough"><i></i></label>
      <label class="cp-switch"><span>卡顿时自动降档</span><input type="checkbox" data-key="adaptive"><i></i></label>
      <label class="cp-switch"><span>自动阅读图文 / 文档</span><input type="checkbox" data-key="documentMode"><i></i></label>
      <label class="cp-switch"><span>资料页自动打开预览</span><input type="checkbox" data-key="autoPreview"><i></i></label>
      <label class="cp-switch"><span>下载课件（可选，与进度无关）</span><input type="checkbox" data-key="autoDownload"><i></i></label>
      <label class="cp-switch"><span>自动继续播放</span><input type="checkbox" data-key="autoResume"><i></i></label>
      <label class="cp-switch"><span>完成后自动下一节</span><input type="checkbox" data-key="autoNext"><i></i></label>
      <label class="cp-switch"><span>自动跳到未完成小节</span><input type="checkbox" data-key="autoJump"><i></i></label>
      <label class="cp-switch"><span>弹题时暂停托管</span><input type="checkbox" data-key="pauseOnObstacle"><i></i></label>
      <label class="cp-switch"><span>发现视频时自动弹出面板</span><input type="checkbox" data-key="autoShow"><i></i></label>
      <div class="cp-field">
        <span>完成判定阈值 <b data-role="threshold-v">98%</b></span>
        <input class="cp-range" type="range" min="80" max="100" step="1" data-role="threshold">
      </div>
      <div class="cp-field">
        <span>下一节延迟 <b data-role="delay-v">3s</b></span>
        <input class="cp-range" type="range" min="0" max="10" step="1" data-role="delay">
      </div>
      <div class="cp-field">
        <span>资料停留时长 <b data-role="material-v">15s</b></span>
        <input class="cp-range" type="range" min="5" max="120" step="5" data-role="material">
      </div>
      <div class="cp-field">
        <span>“下一节”按钮 <b data-role="nextSel-v">自动识别</b></span>
        <button class="cp-btn sm" data-act="pickNext">点我，再点页面上的“下一节”</button>
      </div>
      <button class="cp-btn ghost" data-act="reset">恢复默认设置</button>
    </section>

    <section class="cp-tab" data-panel="logs" hidden>
      <ul class="cp-logs" data-role="logs"></ul>
      <button class="cp-btn ghost" data-act="clear-log">清空日志</button>
    </section>
  </div>

  <nav class="cp-tabs">
    <button data-tab="overview" class="on">概览</button>
    <button data-tab="settings">设置</button>
    <button data-tab="logs">日志</button>
  </nav>
</div>`;

/**
 * 图形化面板：悬浮在页面右下角，Shadow DOM 隔离样式，支持拖动 / 折叠 / 配置持久化。
 */
export function createPanel({ engine, config, logger, env }) {
  const doc = env.document;
  const win = env.window;

  const host = doc.createElement('div');
  host.id = 'coursepilot-host';
  host.setAttribute('data-coursepilot', 'panel');
  // 宿主只做定位锚点：0 尺寸 + 最高层级；面板本身 fixed 到视口
  host.style.cssText = [
    'all: initial',
    'position: fixed',
    'inset: auto',
    'left: 0',
    'top: 0',
    'width: 0',
    'height: 0',
    'margin: 0',
    'padding: 0',
    'border: 0',
    'background: transparent',
    'overflow: visible',
    'z-index: 2147483647',
  ].join('; ');

  const shadow = host.attachShadow({ mode: 'open' });
  const styleEl = doc.createElement('style');
  styleEl.textContent = PANEL_CSS;
  shadow.appendChild(styleEl);

  const holder = doc.createElement('div');
  holder.innerHTML = TEMPLATE;
  const panel = holder.firstElementChild;
  shadow.appendChild(panel);

  const refs = {};
  for (const el of panel.querySelectorAll('[data-role]')) refs[el.getAttribute('data-role')] = el;

  const switches = {};
  for (const el of panel.querySelectorAll('input[data-key]')) switches[el.getAttribute('data-key')] = el;

  const presets = Array.from(panel.querySelectorAll('[data-rate]'));
  const head = panel.querySelector('[data-role="head"]');

  let currentTab = config.get().panel.tab;
  let dragState = null;
  let visible = true;
  let popoverMode = false;

  function render(state) {
    panel.dataset.phase = state.phase;

    refs.status.textContent = state.message || '待机';
    refs.badge.textContent = state.platform.name;
    refs.platform.textContent = state.platform.host || state.platform.name;

    const kind = { video: '视频', document: '图文', material: '资料' }[state.content] || '';
    refs.kind.textContent = kind;
    refs.kind.hidden = !kind;

    const document = state.mode === 'document' ? state.document : null;
    const video = state.video;
    const ratio = document ? document.ratio : video ? video.percent : 0;

    refs.bar.style.width = `${(ratio * 100).toFixed(2)}%`;
    refs.pct.textContent = `${formatPercent(ratio)}%`;
    refs.time.textContent = document
      ? `${formatPercent(ratio)}% · ${document.textLength} 字`
      : video
        ? `${formatClock(video.current)} / ${formatClock(video.duration)}`
        : '--:-- / --:--';

    refs.watchedLabel.textContent = document ? '已读时长' : '已看时长';
    refs.watched.textContent = formatClock(document ? state.session.readSec : state.session.watched);
    refs.segments.textContent = String(state.session.segments);
    refs.effective.textContent = document
      ? `${document.pxPerSec} px/s`
      : state.session.effective > 0
        ? `${state.session.effective.toFixed(2)}×`
        : '—';
    refs.switches.textContent = String(state.session.switches);
    refs.toggle.textContent = state.enabled ? '暂停托管' : '开始托管';
    refs.speedLabel.textContent = document ? '阅读节奏' : '播放倍速';

    const materials = state.materials || { count: 0, downloaded: 0 };
    refs.materials.hidden = materials.count <= 0;
    refs.materialCount.textContent = String(materials.count);

    const outline = state.outline || { total: 0, done: 0, next: '' };
    const outlineVisible = outline.total > 0 || state.phase === 'searching';
    refs.outlineRow.hidden = !outlineVisible;
    if (outlineVisible) {
      if (outline.total === 0) {
        refs.outlineText.textContent = '未识别到课程目录';
        refs.jumpBtn.hidden = true;
        refs.inspectBtn.hidden = false;
      } else {
        refs.inspectBtn.hidden = true;
        refs.jumpBtn.hidden = !outline.next;
        if (outline.next) refs.outlineText.textContent = `未完成：${outline.next}`;
        else if (outline.done > 0) refs.outlineText.textContent = `目录已完成 ${outline.done}/${outline.total}`;
        else refs.outlineText.textContent = `目录 ${outline.total} 节 · 未标记完成状态`;
      }
    }

    refs.rate.textContent = formatRate(state.target);
    if (shadow.activeElement !== refs.speed) refs.speed.value = String(state.target);
    for (const btn of presets) {
      btn.classList.toggle('on', Math.abs(Number(btn.getAttribute('data-rate')) - state.target) < 0.01);
    }
  }

  function syncConfig(cfg) {
    for (const [key, el] of Object.entries(switches)) el.checked = !!cfg[key];
    const threshold = Math.round(cfg.completeThreshold * 100);
    refs.threshold.value = String(threshold);
    refs['threshold-v'].textContent = `${threshold}%`;
    const delay = Math.round(cfg.nextDelayMs / 1000);
    refs.delay.value = String(delay);
    refs['delay-v'].textContent = `${delay}s`;
    refs.material.value = String(cfg.materialReadSec);
    refs['material-v'].textContent = `${cfg.materialReadSec}s`;
    const rawSel = String(cfg.nextSelector || '');
    const sep = rawSel.indexOf('|');
    refs['nextSel-v'].textContent = rawSel
      ? (sep > 0 ? `${rawSel.slice(sep + 1)}（${rawSel.slice(0, sep)}）` : rawSel)
      : '自动识别';
    panel.dataset.folded = cfg.panel.folded ? 'true' : 'false';
    refs.lock.hidden = !cfg.breakthrough;

    const { x, y } = cfg.panel;
    if (typeof x === 'number' && typeof y === 'number') {
      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }
  }

  function setTab(tab) {
    currentTab = PANEL_TABS.includes(tab) ? tab : 'overview';
    for (const section of panel.querySelectorAll('[data-panel]')) {
      section.hidden = section.getAttribute('data-panel') !== currentTab;
    }
    for (const btn of panel.querySelectorAll('[data-tab]')) {
      btn.classList.toggle('on', btn.getAttribute('data-tab') === currentTab);
    }
    if (refs.logs && currentTab === 'logs') refs.logs.scrollTop = refs.logs.scrollHeight;
  }

  function appendLog(entry) {
    if (!entry) {
      refs.logs.textContent = '';
      return;
    }
    const li = doc.createElement('li');
    li.className = `cp-log cp-log-${entry.level}`;
    li.textContent = `${entry.time}  ${entry.message}`;
    refs.logs.appendChild(li);
    while (refs.logs.childElementCount > 120) refs.logs.removeChild(refs.logs.firstElementChild);
    if (currentTab === 'logs') refs.logs.scrollTop = refs.logs.scrollHeight;
  }

  /** 进入 top layer：popover 不受站点 z-index 与堆叠上下文影响 */
  function raiseToTopLayer() {
    if (!popoverMode) return;
    try {
      host.hidePopover();
    } catch {
      /* 未打开时忽略 */
    }
    try {
      host.showPopover();
    } catch {
      // 被策略拒绝时退回普通 fixed + 最高 z-index
      popoverMode = false;
      host.removeAttribute('popover');
    }
  }

  function mount(parent) {
    (parent || doc.body || doc.documentElement).appendChild(host);
    if (!popoverMode && typeof host.showPopover === 'function') {
      host.setAttribute('popover', 'manual');
      popoverMode = true;
    }
    raiseToTopLayer();
  }

  /**
   * 全屏时浏览器只渲染全屏元素子树，必须把面板搬进去才看得见；
   * 搬完重新入栈，避免被全屏元素盖住。
   */
  function onFullscreenChange() {
    const fullscreen = doc.fullscreenElement || doc.webkitFullscreenElement || null;
    const parent = fullscreen || doc.body || doc.documentElement;
    if (host.parentNode === parent) return;
    parent.appendChild(host);
    raiseToTopLayer();
  }

  function show() {
    visible = true;
    host.style.display = '';
    raiseToTopLayer();
  }

  function hide() {
    visible = false;
    host.style.display = 'none';
  }

  function toggleFold() {
    const folded = panel.dataset.folded === 'true';
    panel.dataset.folded = folded ? 'false' : 'true';
    config.set({ panel: { folded: !folded } });
  }

  function onClick(event) {
    const target = event.target;
    const btn = target && typeof target.closest === 'function' ? target.closest('button') : null;
    if (!btn) return;

    const tab = btn.getAttribute('data-tab');
    if (tab) {
      setTab(tab);
      return;
    }

    const rate = btn.getAttribute('data-rate');
    if (rate) {
      engine.setSpeed(Number(rate));
      return;
    }

    switch (btn.getAttribute('data-act')) {
      case 'fold':
        toggleFold();
        break;
      case 'close':
        hide();
        config.set({ panel: { hidden: true } });
        break;
      case 'toggle':
        engine.toggle();
        break;
      case 'next':
        engine.skip();
        break;
      case 'download':
        engine.downloadMaterials();
        break;
      case 'jump':
        engine.jumpToNext();
        break;
      case 'pickNext':
        engine.pickNext();
        setTab('logs');
        break;
      case 'inspect':
        engine.report();
        setTab('logs');
        break;
      case 'reset':
        config.reset();
        engine.tick();
        break;
      case 'clear-log':
        logger.clear();
        break;
      default:
        break;
    }
  }

  function onInput(event) {
    const el = event.target;
    if (!el || typeof el.getAttribute !== 'function') return;
    const role = el.getAttribute('data-role');
    if (role === 'speed') refs.rate.textContent = formatRate(Number(el.value));
    else if (role === 'threshold') refs['threshold-v'].textContent = `${Math.round(Number(el.value))}%`;
    else if (role === 'delay') refs['delay-v'].textContent = `${Math.round(Number(el.value))}s`;
    else if (role === 'material') refs['material-v'].textContent = `${Math.round(Number(el.value))}s`;
  }

  function onChange(event) {
    const el = event.target;
    if (!el || typeof el.getAttribute !== 'function') return;

    const key = el.getAttribute('data-key');
    if (key) {
      config.set({ [key]: el.checked });
      return;
    }

    const role = el.getAttribute('data-role');
    if (role === 'speed') engine.setSpeed(Number(el.value));
    else if (role === 'threshold') config.set({ completeThreshold: Number(el.value) / 100 });
    else if (role === 'delay') config.set({ nextDelayMs: Math.round(Number(el.value)) * 1000 });
    else if (role === 'material') config.set({ materialReadSec: Math.round(Number(el.value)) });
  }

  function onPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    const target = event.target;
    if (target && typeof target.closest === 'function' && target.closest('button')) return;

    const rect = panel.getBoundingClientRect();
    dragState = {
      dx: event.clientX - rect.left,
      dy: event.clientY - rect.top,
      width: rect.width,
      lastX: rect.left,
      lastY: rect.top,
    };
    win.addEventListener('pointermove', onPointerMove, true);
    win.addEventListener('pointerup', onPointerUp, true);
    event.preventDefault();
  }

  function onPointerMove(event) {
    if (!dragState) return;
    const viewportWidth = win.innerWidth || 1280;
    const viewportHeight = win.innerHeight || 800;
    const x = Math.min(Math.max(8, viewportWidth - dragState.width - 8), Math.max(8, event.clientX - dragState.dx));
    const y = Math.min(Math.max(8, viewportHeight - 64), Math.max(8, event.clientY - dragState.dy));
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    dragState.lastX = x;
    dragState.lastY = y;
  }

  function onPointerUp() {
    win.removeEventListener('pointermove', onPointerMove, true);
    win.removeEventListener('pointerup', onPointerUp, true);
    if (dragState && typeof dragState.lastX === 'number') {
      config.set({ panel: { x: Math.round(dragState.lastX), y: Math.round(dragState.lastY) } });
    }
    dragState = null;
  }

  const offEngine = engine.subscribe(render);
  const offConfig = config.subscribe(syncConfig);
  const offLog = logger.subscribe(appendLog);

  panel.addEventListener('click', onClick);
  panel.addEventListener('input', onInput);
  panel.addEventListener('change', onChange);
  head.addEventListener('pointerdown', onPointerDown);

  for (const entry of logger.entries()) appendLog(entry);
  syncConfig(config.get());
  setTab(currentTab);
  render(engine.getState());

  mount(doc.body || doc.documentElement);
  doc.addEventListener('fullscreenchange', onFullscreenChange, true);
  doc.addEventListener('webkitfullscreenchange', onFullscreenChange, true);

  return {
    el: panel,
    show,
    hide,
    isVisible: () => visible,
    destroy() {
      offEngine();
      offConfig();
      offLog();
      panel.removeEventListener('click', onClick);
      panel.removeEventListener('input', onInput);
      panel.removeEventListener('change', onChange);
      head.removeEventListener('pointerdown', onPointerDown);
      win.removeEventListener('pointermove', onPointerMove, true);
      win.removeEventListener('pointerup', onPointerUp, true);
      doc.removeEventListener('fullscreenchange', onFullscreenChange, true);
      doc.removeEventListener('webkitfullscreenchange', onFullscreenChange, true);
      if (typeof host.hidePopover === 'function') {
        try {
          host.hidePopover();
        } catch {
          /* 未打开时忽略 */
        }
      }
      host.remove();
    },
  };
}
