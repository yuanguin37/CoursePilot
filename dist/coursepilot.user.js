// ==UserScript==
// @name         CoursePilot 课程托管助手
// @namespace    https://github.com/coursepilot
// @version      1.8.0
// @description  多平台网课播放托管：倍速突破、自动续播、自动下一节、图形化控制面板（不答题、不伪造记录）
// @author       CoursePilot
// @match        *://*.yuketang.cn/*
// @match        *://*.xuetangx.com/*
// @match        *://*.zhihuishu.com/*
// @match        *://*.icve.com.cn/*
// @match        *://*.chaoxing.com/*
// @match        *://*.xueyinonline.com/*
// @match        *://*.icourse163.org/*
// @match        *://*.smartedu.cn/*
// @match        *://*.ouchn.cn/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// ==/UserScript==
(function () {
  'use strict';

// ---------- src/version.js ----------
const APP_NAME = 'CoursePilot';const VERSION = '1.8.0';const STORAGE_KEY = 'coursepilot.config.v1';

// ---------- src/util.js ----------
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}function clampNumber(value, min, max, fallback) {
  return isFiniteNumber(value) ? clamp(value, min, max) : fallback;
}function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 秒 → 1:02:03 / 02:03，非法值统一显示 --:-- */function formatClock(seconds) {
  if (!isFiniteNumber(seconds) || seconds < 0) return '--:--';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

/** 0~1 的比例 → "63.2"（不带百分号，便于拼接文案） */function formatPercent(ratio) {
  if (!isFiniteNumber(ratio)) return '0.0';
  return (clamp(ratio, 0, 1) * 100).toFixed(1);
}

/** 倍速 → 4× / 1.5× / 0.75× */function formatRate(rate) {
  if (!isFiniteNumber(rate)) return '—';
  return `${rate.toFixed(2).replace(/\.?0+$/, '')}×`;
}

/** 只合并一层嵌套对象，其余按值覆盖；用于配置补丁 */function mergeConfig(base, patch) {
  const output = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (isPlainObject(value) && isPlainObject(base[key])) output[key] = { ...base[key], ...value };
    else output[key] = value;
  }
  return output;
}

// ---------- src/log.js ----------
/**
 * 环形日志：供面板展示、供 API 导出。
 * dedupeMs > 0 时，相同级别+文案在高频轮询下只保留一条。
 */function createLogger({ capacity = 200, dedupeMs = 0, now = () => Date.now() } = {}) {
  const items = [];
  const listeners = new Set();
  let lastKey = '';
  let lastAt = -Infinity;

  function push(level, message, detail) {
    const at = now();
    const key = `${level}:${message}`;
    if (dedupeMs > 0 && key === lastKey && at - lastAt < dedupeMs) return null;
    lastKey = key;
    lastAt = at;

    const entry = {
      at,
      time: new Date(at).toTimeString().slice(0, 8),
      level,
      message: String(message),
      detail: detail === undefined ? null : detail,
    };
    items.push(entry);
    if (items.length > capacity) items.splice(0, items.length - capacity);
    for (const listener of listeners) {
      try {
        listener(entry);
      } catch {
        /* 单个订阅者异常不应影响日志写入 */
      }
    }
    return entry;
  }

  return {
    push,
    debug: (message, detail) => push('debug', message, detail),
    info: (message, detail) => push('info', message, detail),
    warn: (message, detail) => push('warn', message, detail),
    error: (message, detail) => push('error', message, detail),
    entries: () => items.slice(),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clear() {
      items.length = 0;
      for (const listener of listeners) {
        try {
          listener(null);
        } catch {
          /* ignore */
        }
      }
    },
    text: () => items.map((item) => `[${item.time}] ${item.level.toUpperCase()} ${item.message}`).join('\n'),
  };
}

// ---------- src/config.js ----------
const TABS = ['overview', 'settings', 'logs'];const DEFAULT_CONFIG = Object.freeze({
  /** 总开关：关闭后引擎只观察不下发倍速 */
  enabled: true,
  /** 目标倍速（平台允许范围内尽量高，超过 4x 部分平台会静音） */
  speed: 4,
  /** 突破平台倍速上限：拦截播放器把倍速改回它自己的上限 */
  breakthrough: true,
  /** 卡顿时按阶梯自动降档（16× → 12× → 10× → 8× …），避免长时间卡在缓冲 */
  adaptive: true,
  /** 没有视频的图文 / 文档章节按节奏自动滚动阅读 */
  documentMode: true,
  /** 资料页自动打开「预览/查看」入口（只阅读，不下载） */
  autoPreview: true,
  /** 下载课件（可选动作，与进度无关，默认关闭） */
  autoDownload: false,
  /** 资料页停留多少秒算读完 */
  materialReadSec: 15,
  /** 自动扫描课程目录，跳到第一个未完成的小节 */
  autoJump: true,
  /** 用户手动指定的“下一节”元素选择器（自动识别失败时使用） */
  nextSelector: '',
  /** 视频被平台/浏览器暂停时自动续播 */
  autoResume: true,
  /** 本节播完后自动点击“下一节” */
  autoNext: true,
  /** 检测到弹题/答题弹窗时暂停托管，交由人工处理 */
  pauseOnObstacle: true,
  /** 识别到课程内容（视频 / 图文 / 资料）时自动弹出面板，其他页面保持隐藏 */
  autoShow: true,
  /** 点击下一节前的缓冲时间（毫秒），给平台上报进度留出窗口 */
  nextDelayMs: 3000,
  /** 进度达到该比例即视为本节完成 */
  completeThreshold: 0.98,
  /** 引擎轮询间隔（毫秒） */
  tickMs: 1000,
  panel: Object.freeze({ folded: false, hidden: false, tab: 'overview', x: null, y: null }),
});function sanitizeConfig(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const defaults = DEFAULT_CONFIG;
  const panel = isPlainObject(source.panel) ? source.panel : {};

  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : defaults.enabled,
    speed: clampNumber(Number(source.speed), 0.25, 16, defaults.speed),
    breakthrough: typeof source.breakthrough === 'boolean' ? source.breakthrough : defaults.breakthrough,
    adaptive: typeof source.adaptive === 'boolean' ? source.adaptive : defaults.adaptive,
    documentMode: typeof source.documentMode === 'boolean' ? source.documentMode : defaults.documentMode,
    autoPreview: typeof source.autoPreview === 'boolean' ? source.autoPreview : defaults.autoPreview,
    autoDownload: typeof source.autoDownload === 'boolean' ? source.autoDownload : defaults.autoDownload,
    materialReadSec: Math.round(clampNumber(Number(source.materialReadSec), 5, 120, defaults.materialReadSec)),
    autoJump: typeof source.autoJump === 'boolean' ? source.autoJump : defaults.autoJump,
    nextSelector: typeof source.nextSelector === 'string' ? source.nextSelector.slice(0, 200) : defaults.nextSelector,
    autoResume: typeof source.autoResume === 'boolean' ? source.autoResume : defaults.autoResume,
    autoNext: typeof source.autoNext === 'boolean' ? source.autoNext : defaults.autoNext,
    pauseOnObstacle: typeof source.pauseOnObstacle === 'boolean'
      ? source.pauseOnObstacle
      : defaults.pauseOnObstacle,
    autoShow: typeof source.autoShow === 'boolean' ? source.autoShow : defaults.autoShow,
    nextDelayMs: Math.round(clampNumber(Number(source.nextDelayMs), 0, 30000, defaults.nextDelayMs)),
    completeThreshold: clampNumber(Number(source.completeThreshold), 0.5, 1, defaults.completeThreshold),
    tickMs: Math.round(clampNumber(Number(source.tickMs), 300, 5000, defaults.tickMs)),
    panel: {
      folded: typeof panel.folded === 'boolean' ? panel.folded : defaults.panel.folded,
      hidden: typeof panel.hidden === 'boolean' ? panel.hidden : defaults.panel.hidden,
      tab: TABS.includes(panel.tab) ? panel.tab : defaults.panel.tab,
      x: isFiniteNumber(panel.x) ? Math.round(panel.x) : null,
      y: isFiniteNumber(panel.y) ? Math.round(panel.y) : null,
    },
  };
}

/**
 * 配置仓库：read/write 由宿主注入（GM_setValue 或 localStorage）。
 * read 可能返回对象、JSON 字符串或 null，统一交给 sanitize 兜底。
 */function createConfigStore({ read, write } = {}) {
  const readSafe = typeof read === 'function' ? read : () => null;
  const writeSafe = typeof write === 'function' ? write : () => {};
  const listeners = new Set();

  let raw = null;
  try {
    raw = readSafe();
  } catch {
    raw = null;
  }
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }

  let current = sanitizeConfig(raw);

  function emit(reason) {
    const snapshot = api.get();
    for (const listener of listeners) {
      try {
        listener(snapshot, reason);
      } catch {
        /* ignore */
      }
    }
  }

  function commit(next, reason) {
    current = sanitizeConfig(next);
    try {
      writeSafe(current);
    } catch {
      /* 存储被禁用时降级为内存配置 */
    }
    emit(reason);
    return api.get();
  }

  const api = {
    get() {
      return { ...current, panel: { ...current.panel } };
    },
    set(patch) {
      return commit(mergeConfig(current, patch), 'set');
    },
    reset() {
      return commit({}, 'reset');
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return api;
}

// ---------- src/dom.js ----------
/**
 * 跨层 DOM 探测：同源 iframe + 开放 Shadow DOM。
 * 所有扫描都有节点预算，避免在超大页面上把主线程拖死。
 */
const MAX_NODES = 6000;
const MAX_DEPTH = 3;
const CACHE_TTL = 400;

const cache = new Map();

/** 扫描时跳过 CoursePilot 自身的面板，避免把面板按钮当成站点按钮点击 */
function isOwnUi(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.id === 'coursepilot-host') return true;
  return typeof el.hasAttribute === 'function' && el.hasAttribute('data-coursepilot');
}

function scanVideos(root, budget, result) {
  const seen = new Set();

  (function walk(node, depth) {
    if (!node || seen.has(node) || depth > MAX_DEPTH) return;
    if (budget.count > MAX_NODES) return;
    seen.add(node);

    if (typeof node.querySelectorAll !== 'function') return;
    for (const video of node.querySelectorAll('video')) {
      if (!result.includes(video)) {
        result.push(video);
        budget.count += 1;
      }
    }

    for (const el of node.querySelectorAll('*')) {
      budget.count += 1;
      if (budget.count > MAX_NODES) return;
      if (isOwnUi(el)) continue;
      if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
      if (el.tagName === 'IFRAME') {
        let doc = null;
        try {
          doc = el.contentDocument;
        } catch {
          doc = null;
        }
        if (doc) walk(doc, depth + 1);
      }
    }
  })(root, 0);
}function collectVideos(root) {
  const result = [];
  if (!root) return result;
  scanVideos(root, { count: 0 }, result);
  return result;
}

function scanSelector(root, selector) {
  const result = [];
  const seen = new Set();
  const budget = { count: 0 };

  (function walk(node, depth) {
    if (!node || seen.has(node) || depth > MAX_DEPTH || budget.count > MAX_NODES) return;
    seen.add(node);
    if (typeof node.querySelectorAll !== 'function') return;

    try {
      for (const el of node.querySelectorAll(selector)) result.push(el);
    } catch {
      return; // 非法选择器直接放弃，不影响其它平台
    }

    for (const el of node.querySelectorAll('*')) {
      budget.count += 1;
      if (budget.count > MAX_NODES) return;
      if (isOwnUi(el)) continue;
      if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
      if (el.tagName === 'IFRAME') {
        let doc = null;
        try {
          doc = el.contentDocument;
        } catch {
          doc = null;
        }
        if (doc) walk(doc, depth + 1);
      }
    }
  })(root, 0);

  return result;
}function queryAllDeep(root, selector) {
  if (!root || !selector) return [];
  const hit = cache.get(selector);
  const now = Date.now();
  if (hit && hit.root === root && now - hit.at < CACHE_TTL) return hit.value;

  const value = scanSelector(root, selector);
  if (cache.size > 60) cache.clear();
  cache.set(selector, { root, at: now, value });
  return value;
}function isVisible(el) {
  if (!el || el.isConnected === false) return false;
  if (el.hidden) return false;
  const doc = el.ownerDocument;
  const view = doc && doc.defaultView;
  if (view && typeof view.getComputedStyle === 'function') {
    try {
      const style = view.getComputedStyle(el);
      if (style && (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)) {
        return false;
      }
    } catch {
      /* 跨域元素拿不到 computedStyle，退化为 isConnected 判断 */
    }
  }
  if (typeof el.getClientRects === 'function' && doc && doc.defaultView) {
    try {
      return el.getClientRects().length > 0;
    } catch {
      return true;
    }
  }
  return true;
}function findFirstVisible(root, selectors) {
  for (const selector of selectors) {
    for (const el of queryAllDeep(root, selector)) {
      if (isVisible(el)) return el;
    }
  }
  return null;
}

/** 只取元素自身的直接文本，避免父容器把整段文字算进来 */
function ownTextOf(el) {
  const nodes = el && el.childNodes;
  if (!nodes) return String((el && el.textContent) || '');
  let text = '';
  for (const node of nodes) {
    if (node.nodeType === 3) text += node.nodeValue || '';
  }
  return text;
}

/** 判断元素像不像一个可点击控件：角色、tabindex、class 关键词、cursor:pointer */
function looksClickable(el) {
  if (!el || typeof el.getAttribute !== 'function') return false;
  if (el.getAttribute('role') === 'button') return true;
  if (typeof el.hasAttribute === 'function'
    && (el.hasAttribute('tabindex') || el.hasAttribute('onclick') || el.hasAttribute('href'))) return true;

  if (/(btn|button|click|link|next|prev|switch|tab)/i.test(String(el.className || ''))) return true;

  const view = el.ownerDocument && el.ownerDocument.defaultView;
  if (view && typeof view.getComputedStyle === 'function') {
    try {
      return view.getComputedStyle(el).cursor === 'pointer';
    } catch {
      return false;
    }
  }
  return false;
}function findByText(root, labels) {
  const candidates = queryAllDeep(root, 'button, a, [role="button"], .btn, .button');
  for (const el of candidates) {
    const text = (el.textContent || '').replace(/\s+/g, '');
    if (!text || text.length > 12) continue;
    if (labels.some((label) => text === label || text.startsWith(label))) {
      if (isVisible(el)) return el;
    }
  }

  // 很多平台的“下一节”是 div/span 加点击事件，不是 button/a
  for (const el of queryAllDeep(root, 'div, span, li, i, em, strong, p')) {
    const text = ownTextOf(el).replace(/\s+/g, '');
    if (!text || text.length > 6) continue;
    if (!labels.some((label) => text === label)) continue;
    if (!isVisible(el) || !looksClickable(el)) continue;
    return el;
  }

  return null;
}

/**
 * 兜底找“下一个”：不依赖文案，只看 class / id / aria-label / data-* 里的 next 语义。
 * 很多播放器的下一节是纯图标按钮，没有文字。
 */function findGenericNext(root) {
  const selector = [
    '[class*="next" i]',
    '[id*="next" i]',
    '[aria-label*="下一"]',
    '[title*="下一"]',
    '[data-action*="next" i]',
    '[data-act*="next" i]',
    '[data-type*="next" i]',
    '[class*="arrow-right" i]',
    '[class*="right-arrow" i]',
    '[class*="icon-right" i]',
  ].join(', ');

  for (const el of queryAllDeep(root, selector)) {
    const className = String(el.className || '');
    if (/(prev|previous|disabled|is-disabled|forbid)/i.test(className)) continue;
    if (el.id === 'coursepilot-host' || el.closest?.('#coursepilot-host')) continue;

    const text = String(el.textContent || '').replace(/\s+/g, '');
    if (text.length > 12) continue; // 命中整块内容时跳过
    if (!isVisible(el)) continue;
    return el;
  }

  return null;
}

/**
 * 给元素生成一个尽量稳定的 CSS 选择器：id → class（过滤哈希/长数字）→ nth-child 路径。
 * 用于“让用户点一次真实按钮，记住它”。
 */
function ownSegment(el) {
  if (!el || el.nodeType !== 1) return '';

  if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return `#${el.id}`;

  const classes = String(el.className || '')
    .split(/\s+/)
    .filter((name) => name && name.length < 40 && !/^[a-f0-9]{8,}$/i.test(name) && !/\d{3,}/.test(name))
    .slice(0, 2);

  return classes.length ? `${String(el.tagName || '').toLowerCase()}.${classes.join('.')}` : '';
}function describeSelector(el) {
  if (!el || el.nodeType !== 1) return '';

  // 元素自己有 id / class 就够了，选择器越短越不容易失效
  const own = ownSegment(el);
  if (own) return own;

  const parts = [];
  let node = el;

  for (let depth = 0; node && node.nodeType === 1 && depth < 3; depth += 1) {
    const segment = ownSegment(node);
    if (segment) {
      parts.unshift(segment);
      break;
    }

    const tag = String(node.tagName || '').toLowerCase();
    const parent = node.parentElement;
    const siblings = parent ? Array.from(parent.children) : [];
    const index = siblings.indexOf(node) + 1;
    parts.unshift(siblings.length > 1 && index > 0 ? `${tag}:nth-child(${index})` : tag);
    node = parent;
  }

  return parts.join(' > ');
}

/** 模拟一次完整的点击序列，兼容 Vue / React 的合成事件 */function clickElement(el) {
  if (!el) return false;
  const doc = el.ownerDocument;
  if (!doc || typeof el.dispatchEvent !== 'function') return false;
  const view = doc.defaultView;
  const Ctor = view && view.MouseEvent;
  const make = (type) => {
    if (typeof Ctor === 'function') {
      try {
        return new Ctor(type, { bubbles: true, cancelable: true, view });
      } catch {
        /* 老内核不支持时降级为自定义事件 */
      }
    }
    const event = doc.createEvent ? doc.createEvent('MouseEvents') : null;
    if (event && event.initMouseEvent) event.initMouseEvent(type, true, true, view, 1, 0, 0, 0, 0, false, false, false, false, 0, null);
    return event;
  };

  // 部分播放器监听 pointerdown / pointerup，补齐完整点击序列
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    const event = make(type);
    if (!event) continue;
    try {
      el.dispatchEvent(event);
    } catch {
      /* 单个事件失败不阻断后续 */
    }
  }
  return true;
}

// ---------- src/media.js ----------
const RATE_MIN = 0.25;const RATE_MAX = 16;
/** 主流浏览器在 4× 以上会自动静音，用于给用户提示 */const RATE_AUDIBLE_MAX = 4;

function rateDescriptor() {
  try {
    const proto = globalThis.HTMLMediaElement && globalThis.HTMLMediaElement.prototype;
    return proto ? Object.getOwnPropertyDescriptor(proto, 'playbackRate') || null : null;
  } catch {
    return null;
  }
}

/** 读取当前生效倍速；若已安装锁定，返回锁定目标值 */function readRate(video) {
  if (!video) return null;
  try {
    const value = Number(video.playbackRate);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * 过滤被隐藏的占位视频：图文页常保留一个 display:none 的 <video>，
 * 不排除的话会被误判成视频章节，一直卡在“视频尚未就绪”。
 */function isVisibleMedia(video) {
  if (!video || video.isConnected === false || video.hidden) return false;
  const doc = video.ownerDocument;
  const view = doc && doc.defaultView;
  if (view && typeof view.getComputedStyle === 'function') {
    try {
      const style = view.getComputedStyle(video);
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    } catch {
      /* 跨文档拿不到样式时按可见处理 */
    }
  }
  return true;
}function readMedia(video) {
  if (!video) return null;
  try {
    const duration = Number(video.duration);
    const current = Number(video.currentTime);
    return {
      duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
      currentTime: Number.isFinite(current) && current >= 0 ? current : 0,
      paused: typeof video.paused === 'boolean' ? video.paused : true,
      ended: !!video.ended,
      seeking: !!video.seeking,
      ready: Number(video.readyState) >= 1,
      readyState: Number(video.readyState) || 0,
      rate: readRate(video),
      muted: !!video.muted,
      src: String(video.currentSrc || video.src || ''),
    };
  } catch {
    return null;
  }
}

/**
 * 倍速管理器。
 *
 * 常规模式：直接写原生 playbackRate，平台重置后由引擎下一轮补写。
 * 突破模式（enforce）：在 video 实例上定义一个同名访问器，读取永远返回目标倍速、
 * 写入被吞掉。平台自己的播放器把倍速改回 2× 时会被这一层拦住，
 * 因此可以把「平台只开放到 2×」的播放器拉到 5× / 10× 并保持住。
 */function createRateManager() {
  const originals = new WeakMap();
  const guards = new WeakMap();

  function nativeRead(video) {
    const accessor = rateDescriptor();
    try {
      if (accessor && typeof accessor.get === 'function') return Number(accessor.get.call(video));
      return Number(video.playbackRate);
    } catch {
      return null;
    }
  }

  function nativeWrite(video, value) {
    const accessor = rateDescriptor();
    if (accessor && typeof accessor.set === 'function') accessor.set.call(video, value);
    else video.playbackRate = value;
  }

  function installGuard(video, target) {
    let record = guards.get(video);
    if (!record) {
      const accessor = rateDescriptor();
      if (!accessor || typeof accessor.set !== 'function') {
        return { ok: false, error: '当前浏览器不支持倍速锁定' };
      }
      record = { target, accessor };
      try {
        Object.defineProperty(video, 'playbackRate', {
          configurable: true,
          enumerable: true,
          get: () => record.target,
          set: () => record.target,
        });
      } catch (error) {
        return { ok: false, error: (error && error.message) || '倍速锁定失败' };
      }
      guards.set(video, record);
    }

    record.target = target;
    try {
      record.accessor.set.call(video, target);
      return { ok: true };
    } catch {
      return { ok: false, error: '倍速写入失败' };
    }
  }

  function releaseGuard(video) {
    if (!guards.has(video)) return false;
    guards.delete(video);
    try {
      delete video.playbackRate;
    } catch {
      /* 属性不可删除时保持原样，下次 restore 仍会写回原值 */
    }
    return true;
  }

  return {
    apply(video, rate, options = {}) {
      if (!video) return { ok: false, error: '视频元素不存在' };
      if (!isFiniteNumber(rate)) return { ok: false, error: '倍速参数无效' };
      const target = Math.min(RATE_MAX, Math.max(RATE_MIN, rate));

      try {
        if (!originals.has(video)) originals.set(video, nativeRead(video));

        let enforced = false;
        if (options.enforce) {
          enforced = installGuard(video, target).ok;
        } else if (guards.has(video)) {
          releaseGuard(video);
        }

        nativeWrite(video, target);
        const real = nativeRead(video);
        if (real === null || Math.abs(real - target) > 0.01) {
          return { ok: false, error: '播放器拒绝该倍速', enforced };
        }
        return { ok: true, real, enforced };
      } catch (error) {
        return { ok: false, error: (error && error.message) || '倍速写入失败' };
      }
    },

    restore(video) {
      if (!video) return { ok: true, restored: false };
      const unlocked = releaseGuard(video);
      if (!originals.has(video)) return { ok: true, restored: false, unlocked };

      const original = originals.get(video);
      originals.delete(video);
      try {
        nativeWrite(video, isFiniteNumber(original) ? original : 1);
        return { ok: true, restored: true, real: nativeRead(video), unlocked };
      } catch (error) {
        return { ok: false, error: (error && error.message) || '恢复倍速失败', unlocked };
      }
    },

    isLocked: (video) => guards.has(video),
  };
}

// ---------- src/reader.js ----------
/**
 * 图文 / 文档阅读与课件资料：
 * - createReader 负责找到可滚动的阅读容器并按节奏推进
 * - findMaterials 负责识别页面上的课件、附件下载入口
 * 只驱动真实 UI（滚动、点击），不调用任何平台接口。
 */
const TEXT_MIN = 400;
const SCROLL_MIN = 200;
const CACHE_MS = 800;

/** 1× 时的滚动速度（像素/秒），倍速在此基础上线性放大 */const READ_BASE_PX = 16;

const FILE_PATTERN = /\.(pdf|docx?|pptx?|xlsx?|zip|rar|7z|txt|md|csv|key|pages)(?:[?#]|$)/i;
/** 预览/查看类入口：点了只打开阅读页，不触发下载 */
const PREVIEW_TEXT = /(预览|查看|阅读|在线预览|打开)/;
const PREVIEW_HREF = /(preview|viewer|view\?|detail|\/view\/|onlineview)/i;

function visibleIn(doc, el) {
  if (!el || el.isConnected === false || el.hidden) return false;
  const view = doc.defaultView;
  const style = view && typeof view.getComputedStyle === 'function' ? view.getComputedStyle(el) : null;
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
  return true;
}function createReader(env) {
  const doc = env.document;
  let cache = { target: null, explicit: false, at: 0 };

  function scrollable(el) {
    return el && el.scrollHeight > el.clientHeight + SCROLL_MIN && el.clientHeight >= 160;
  }

  function findBySelectors(selectors) {
    for (const selector of selectors || []) {
      let nodes = [];
      try {
        nodes = doc.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const el of nodes) {
        if (el.id === 'coursepilot-host') continue;
        if (!visibleIn(doc, el) || !scrollable(el)) continue;
        return el;
      }
    }
    return null;
  }

  /**
   * 正文常常滚动在一个内层容器里（PDF 预览、文档阅读器），
   * 平台选择器没覆盖时，按“面积最大的可滚动主区域”兜底。
   */
  function findNestedScroller() {
    let best = null;
    let bestArea = 0;
    let scanned = 0;

    let nodes = [];
    try {
      nodes = doc.querySelectorAll('div, main, section, article');
    } catch {
      return null;
    }

    for (const el of nodes) {
      if (++scanned > 1500) break;
      if (el.id === 'coursepilot-host') continue;
      if (!el.clientWidth || el.clientWidth < 400) continue;
      if (!scrollable(el) || !visibleIn(doc, el)) continue;

      const area = el.clientHeight * el.clientWidth;
      if (area <= bestArea) continue;

      const text = String(el.textContent || '').trim();
      const hasMedia = !!el.querySelector('canvas, img, embed, object, iframe, svg');
      if (text.length < 200 && !hasMedia) continue;

      best = el;
      bestArea = area;
    }

    return best;
  }

  function find() {
    const now = Date.now();
    if (cache.target && cache.target.isConnected && now - cache.at < CACHE_MS) return cache.target;

    const profile = env.profile || {};
    let target = findBySelectors(profile.reader);
    let explicit = !!target;

    if (!target) target = findNestedScroller();

    if (!target) {
      const root = doc.scrollingElement || doc.documentElement;
      if (root && root.scrollHeight > root.clientHeight + SCROLL_MIN) target = root;
    }

    cache = { target: target || null, explicit, at: now };
    return cache.target;
  }

  function metrics(target) {
    const el = target || find();
    if (!el) return null;

    const isRoot = el === doc.scrollingElement || el === doc.documentElement || el === doc.body;
    const scrollTop = isRoot ? Number(env.window.pageYOffset) || el.scrollTop || 0 : el.scrollTop || 0;
    const clientHeight = isRoot ? Number(env.window.innerHeight) || el.clientHeight || 0 : el.clientHeight || 0;
    const scrollHeight = el.scrollHeight || 0;
    const max = Math.max(1, scrollHeight - clientHeight);
    const ratio = Math.min(1, Math.max(0, scrollTop / max));

    return {
      target: el,
      isRoot,
      explicit: cache.explicit && el === cache.target,
      scrollTop,
      clientHeight,
      scrollHeight,
      ratio,
      atBottom: scrollTop >= max - 4 || ratio >= 0.995,
      textLength: ((doc.body && doc.body.innerText) || '').trim().length,
    };
  }

  /** 页面是否值得自动阅读：命中平台阅读容器，或整页文档足够长 */
  function canRead() {
    const info = metrics();
    if (!info) return false;
    if (info.explicit) return true;
    return info.isRoot && info.textLength >= TEXT_MIN;
  }

  function scrollBy(target, delta) {
    if (!target || !Number.isFinite(delta) || delta <= 0) return false;
    const isRoot = target === doc.scrollingElement || target === doc.documentElement || target === doc.body;
    try {
      if (isRoot) env.window.scrollBy({ top: delta, behavior: 'auto' });
      else target.scrollTop += delta;
      return true;
    } catch {
      return false;
    }
  }

  return { find, metrics, canRead, scrollBy };
}

function labelOf(el) {
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
  if (text) return text.slice(0, 24);
  const title = el.getAttribute && (el.getAttribute('title') || el.getAttribute('download'));
  return (title || '').slice(0, 24);
}

function keyOf(el, href) {
  return href || labelOf(el);
}

/** 浏览器内置 PDF 阅读器（embed / cross-origin iframe）无法被脚本滚动 */function findPdfViewer(doc) {
  if (!doc || typeof doc.querySelectorAll !== 'function') return null;
  try {
    const nodes = doc.querySelectorAll('embed[type="application/pdf"], object[type="application/pdf"], iframe[src*=".pdf"], iframe[src*="pdfjs"]');
    return nodes.length ? nodes[0] : null;
  } catch {
    return null;
  }
}

/** 课程列表里的“未读 / 未完成”行是章节入口，不是可下载的资料 */
function looksLikeLessonRow(el) {
  return /(未读|未完成|未开始|未学习|已读|已学完|已完成)/.test(String(el.textContent || ''));
}

/** 只有带文件语义的入口才算资料：文件后缀、download/attach/file 语义、download 属性或“下载”文案 */
function isFileLike(el, href) {
  if (FILE_PATTERN.test(href)) return true;
  if (/download|attach|file/i.test(href)) return true;
  if (typeof el.hasAttribute === 'function' && el.hasAttribute('download')) return true;
  if (/(download|attach|file)/i.test(`${el.className || ''} ${el.id || ''}`)) return true;
  return /下载/.test(labelOf(el));
}

/**
 * 找出页面上的课件/附件下载入口：优先平台专属选择器，再按文件后缀兜底。
 * 返回 [{ el, key, label }]，同一条链接只保留一次。
 */function findMaterials(doc, profile = {}) {
  if (!doc || typeof doc.querySelectorAll !== 'function') return [];

  const seen = new Set();
  const items = [];

  const push = (el, key, label, href = '') => {
    if (!key || seen.has(key) || items.length >= 30) return;
    seen.add(key);
    const preview = PREVIEW_TEXT.test(label || '') || PREVIEW_HREF.test(href);
    items.push({ el, key, label: label || '资料', preview });
  };

  for (const selector of profile.download || []) {
    let nodes = [];
    try {
      nodes = doc.querySelectorAll(selector);
    } catch {
      continue;
    }
    for (const el of nodes) {
      if (looksLikeLessonRow(el)) continue;
      const href = el.getAttribute ? el.getAttribute('href') || el.getAttribute('data-url') || '' : '';
      push(el, keyOf(el, href), labelOf(el), href);
    }
  }

  let links = [];
  try {
    links = doc.querySelectorAll('a[href]');
  } catch {
    links = [];
  }

  for (const el of links) {
    const href = el.getAttribute('href') || '';
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) continue;
    if (!isFileLike(el, href)) continue;
    if (looksLikeLessonRow(el)) continue;
    push(el, keyOf(el, href.split('#')[0]), labelOf(el) || decodeURIComponent(href.split('/').pop() || '资料'), href);
  }

  return items;
}

// ---------- src/outline.js ----------
/**
 * 课程目录扫描：找出「哪一章哪一节」，供引擎跳转与顺序推进。
 * 只读页面 DOM 并点击目录项，不请求任何平台接口。
 *
 * 三条查找路径：平台声明选择器 → 目录类名 → 纯结构（标题像章节的列表）。
 */
const DONE_TEXT = /(已学完|已完成|已看完|完成学习|已学习|已读)/;
const TODO_TEXT = /(未完成|未读|未学|未开始|待学习|未观看|未阅读|待完成|学习中)/;
// 用词边界避免把 incomplete / undone 这类“未完成”类名误判成已完成
const DONE_CLASS = /(finished|\bfinish\b|\bcomplete\b|\bcompleted\b|is-done|passed|studyed|\bdone\b)/i;
const PERCENT = /(\d{1,3})\s*%/;
const HINT_CLASS = /(catalog|chapter|outline|directory|section|course-?tree|knowledge|lesson)/i;
const COLLAPSED = /(collapsed|close|closed|unfold|expand)/i;
const OUTLINE_ACTIVE = /\b(active|current|playing|selected|now)\b/i;

/** 当前小节的高亮 class 可能挂在行内子节点，而不是整行上 */
function isActiveItem(el) {
  if (!el) return false;

  let nodes = [el];
  try {
    nodes = [el, ...el.querySelectorAll('[class], [aria-current]')];
  } catch {
    /* ignore */
  }

  return nodes.some((node) => {
    if (OUTLINE_ACTIVE.test(classOf(node))) return true;
    try {
      return /^(page|step|true)$/i.test(node.getAttribute('aria-current') || '');
    } catch {
      return false;
    }
  });
}

/** 只挑与“当前/完成/图标”有关的关键节点，避免探针输出整页 DOM */
function stateHintsOf(el) {
  const hints = [];
  const seen = new Set();
  let nodes = [el];
  try {
    nodes = [el, ...el.querySelectorAll('[class], [data-status], [aria-current], [aria-label]')];
  } catch {
    /* ignore */
  }

  for (const node of nodes) {
    if (hints.length >= 8) break;
    const cls = classOf(node).trim();
    if (!cls || !/(active|current|playing|selected|done|finish|complete|check|pass|status|icon)/i.test(cls)) continue;

    const tag = String(node.tagName || '').toLowerCase();
    const hint = `${tag}.${cls}`;
    if (seen.has(hint)) continue;
    seen.add(hint);
    hints.push(hint);
  }

  return hints;
}

/** 标题像“1.1 / 第3章 / xx视频”这类章节名 */
const TITLE_HINT = /^(\d+(\.\d+)+|\d+[、.．\s]|第[一二三四五六七八九十百零\d]+[章节讲单元课]|.{0,8}(视频|图文|文档|资料|测验|作业))/;

const ITEM_SELECTOR = [
  'li',
  'a',
  '[role="treeitem"]',
  '[class*="item"]',
  '[class*="section"]',
  '[class*="chapter"]',
  '[class*="lesson"]',
  '[class*="node"]',
  '[data-id]',
].join(', ');

const CONTAINER_SELECTOR = [
  '[class*="catalog"]',
  '[class*="chapter"]',
  '[class*="outline"]',
  '[class*="courseTree"]',
  '[class*="course-tree"]',
  '[class*="section-list"]',
  '[class*="lesson-list"]',
  '[class*="knowledge"]',
].join(', ');

const MAX_ITEMS = 200;
const MAX_STRUCTURE_NODES = 800;

function textOf(el) {
  const raw = el.innerText !== undefined ? el.innerText : el.textContent;
  return String(raw || '').replace(/\s+/g, ' ').trim();
}

function classOf(el) {
  const value = el && el.className;
  if (typeof value === 'string') return value;
  if (value && typeof value.baseVal === 'string') return value.baseVal;
  return '';
}

function readStateAttrs(el) {
  if (!el || typeof el.getAttribute !== 'function') return null;

  const status = el.getAttribute('data-status') || el.getAttribute('data-state');
  if (status) {
    if (/^(1|true|finished|complete|completed|done|end|pass|passed)$/i.test(status)) return true;
    if (/^(0|false|unfinished|todo|start|none|init|new)$/i.test(status)) return false;
  }

  const progress = el.getAttribute('data-progress') ?? el.getAttribute('data-percent');
  if (progress !== null && progress !== undefined && progress !== '') {
    const value = Number(String(progress).replace('%', ''));
    if (Number.isFinite(value)) return value >= 99;
  }

  const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`;
  if (DONE_TEXT.test(label)) return true;
  if (TODO_TEXT.test(label)) return false;

  return null;
}

/** 状态文案常挂在整行上，而不在标题链接里；向上找一层“行”容器 */
function closestRow(el) {
  if (typeof el.closest !== 'function') return null;
  const host = el.closest('li, tr, [class*="item"], [class*="section"], [class*="chapter"], [class*="lesson"], [class*="row"]');
  if (!host || host === el) return null;
  return textOf(host).length <= 120 ? host : null;
}

function stateOf(el) {
  const host = closestRow(el);
  const text = host ? `${textOf(el)} ${textOf(host)}` : textOf(el);

  if (DONE_TEXT.test(text)) return true;
  if (TODO_TEXT.test(text)) return false;

  const percent = PERCENT.exec(text);
  if (percent) return Number(percent[1]) >= 99;

  if (DONE_CLASS.test(`${classOf(el)} ${classOf(host || el)}`)) return true;

  const attr = readStateAttrs(el) ?? (host ? readStateAttrs(host) : null);
  if (attr !== null) return attr;

  const mark = el.querySelector('[class*="finish"], [class*="complete"], [class*="done"], [class*="checked"], .icon-check, .icon-success');
  if (mark) return true;

  return null;
}

/** 去掉行首的类型标签与行尾的状态词，得到干净的小节标题 */
function cleanTitle(text) {
  return text
    .replace(/^(视频|图文|文档|资料|测验|作业|讨论)\s*/, '')
    .replace(/\s*(未读|未完成|未开始|已完成|已学完|已读|学习中)\s*$/, '')
    .trim();
}

/**
 * 行容器（带状态文案）不一定可点击，真正能跳转的往往是里面的 <a href>。
 * 雨课堂这类 SPA 的点击目标不固定，所以按“标题链接 → 整行 → 行内其它节点”排好候选，
 * 点不动就依次换下一个。
 */
function clickTargetsOf(el) {
  if (!el) return [];

  const list = [];
  const push = (node) => {
    if (node && !list.includes(node)) list.push(node);
  };

  try {
    if (typeof el.matches === 'function' && el.matches('a[href], [role="button"], [onclick]')) push(el);
  } catch {
    /* ignore */
  }

  try {
    const anchors = Array.from(el.querySelectorAll('a[href], [role="button"], [onclick]'));
    // 标题链接通常是文字最长的那个
    anchors.sort((a, b) => textOf(b).length - textOf(a).length);
    anchors.forEach(push);
  } catch {
    /* ignore */
  }

  push(el);

  try {
    for (const node of el.querySelectorAll('span, div')) {
      if (list.length >= 5) break;
      const text = textOf(node);
      if (text.length > 0 && text.length <= 60) push(node);
    }
  } catch {
    /* ignore */
  }

  return list.slice(0, 5);
}

function itemsOf(container) {
  const seen = new Set();
  const items = [];

  for (const el of container.querySelectorAll(ITEM_SELECTOR)) {
    if (items.length >= MAX_ITEMS) break;
    if (el === container) continue;

    const raw = textOf(el);
    if (raw.length < 2 || raw.length > 80) continue;

    const title = cleanTitle(raw);
    if (title.length < 2 || seen.has(title)) continue;
    // 目录里混着的“返回/退出”入口绝不是章节，绝不能点
    if (/^(返回|退出|回到|首页)/.test(title)) continue;
    if (/(back|return|exit)/i.test(classOf(el))) continue;

    const targets = clickTargetsOf(el);
    const clickEl = targets[0] || el;
    const href = clickEl && typeof clickEl.getAttribute === 'function' ? clickEl.getAttribute('href') || '' : '';

    const attrs = {};
    try {
      for (const key of ['node_id', 'data-node-id', 'nodeid', 'data-id', 'id']) {
        const value = el.getAttribute(key);
        if (value) attrs[key] = value;
      }
    } catch {
      /* ignore */
    }

    seen.add(title);
    items.push({
      el,
      clickEl,
      targets,
      href,
      attrs,
      className: classOf(el).slice(0, 80),
      title: title.slice(0, 60),
      done: stateOf(el),
      key: title.slice(0, 60),
      clickTag: String((clickEl && clickEl.tagName) || '').toLowerCase(),
    });
  }

  return items;
}

function namedCandidates(doc, profile) {
  const found = [];

  for (const selector of profile.outline || []) {
    try {
      for (const node of doc.querySelectorAll(selector)) found.push({ node, source: 'profile' });
    } catch {
      /* 平台选择器写法有误时跳过 */
    }
  }

  try {
    for (const node of doc.querySelectorAll(CONTAINER_SELECTOR)) found.push({ node, source: 'class' });
  } catch {
    /* ignore */
  }

  return found;
}

/** 没有目录类名时，靠“标题像章节”的连续子项反推目录 */
function structureCandidates(doc) {
  const found = [];
  let scanned = 0;

  let nodes = [];
  try {
    nodes = doc.querySelectorAll('ul, ol, div, section');
  } catch {
    return found;
  }

  for (const node of nodes) {
    if (++scanned > MAX_STRUCTURE_NODES) break;
    const children = node.children;
    if (!children || children.length < 2 || children.length > MAX_ITEMS) continue;

    let matched = 0;
    for (const child of children) {
      const title = textOf(child);
      if (title.length < 2 || title.length > 60) continue;
      if (TITLE_HINT.test(title)) matched += 1;
    }

    if (matched >= Math.max(2, Math.ceil(children.length * 0.5))) found.push({ node, source: 'structure' });
  }

  return found;
}

function dedupe(candidates) {
  const seen = new Set();
  return candidates.filter(({ node }) => {
    if (!node || seen.has(node) || node.id === 'coursepilot-host') return false;
    seen.add(node);
    return true;
  });
}function createOutline(env) {
  const doc = env.document;
  let lastExpandAt = 0;
  /** 每个小节点过几次，用于轮换点击目标 */
  const attempts = new Map();

  function allCandidates(profile) {
    return dedupe([...namedCandidates(doc, profile), ...structureCandidates(doc)]);
  }

  function pick(profile) {
    const candidates = allCandidates(profile);
    let best = null;
    let bestScore = 0;
    let bestItems = [];
    let bestSource = '';

    for (const { node, source } of candidates) {
      const items = itemsOf(node);
      if (items.length < 2) continue;
      const stateCount = items.filter((item) => item.done !== null).length;
      const score = (source === 'profile' ? 120 : source === 'class' ? 60 : 10)
        + (HINT_CLASS.test(classOf(node)) ? 20 : 0)
        + Math.min(items.length, 50)
        + stateCount * 10;

      if (score > bestScore) {
        best = node;
        bestScore = score;
        bestItems = items;
        bestSource = source;
      }
    }

    return { container: best, items: bestItems, candidates: candidates.length, source: bestSource };
  }

  /** 折叠的章节不会渲染小节，展开后再扫一次（20 秒最多一次，最多点 2 下） */
  function expandCollapsed(container) {
    if (!container || Date.now() - lastExpandAt < 20000) return false;
    lastExpandAt = Date.now();

    let clicked = 0;
    const nodes = container.querySelectorAll('[aria-expanded="false"], [class*="collapsed"], [class*="closed"]');
    for (const node of nodes) {
      if (clicked >= 2) break;
      if (!COLLAPSED.test(`${classOf(node)} ${node.getAttribute('aria-expanded') || ''}`)) continue;
      try {
        node.click();
        clicked += 1;
      } catch {
        /* ignore */
      }
    }
    return clicked > 0;
  }

  function scan(profile = {}) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return null;

    let { container, items, candidates, source } = pick(profile);
    if (!container) return null;

    const doneCount = () => items.filter((item) => item.done === true).length;
    if ((items.length < 3 || doneCount() === items.length) && expandCollapsed(container)) {
      ({ container, items, source } = pick(profile));
      if (!container) return null;
    }

    if (items.length < 2) return null;

    const stateMarkers = items.filter((item) => item.done !== null).length;
    const trusted = stateMarkers > 0
      || (Array.isArray(profile.outline) && profile.outline.length > 0)
      || HINT_CLASS.test(classOf(container));

    const done = items.filter((item) => item.done === true).length;

    let next = null;
    if (trusted) {
      if (stateMarkers > 0) {
        next = items.find((item) => item.done !== true) || null;
      } else {
        const activeIndex = items.findIndex((item) => isActiveItem(item.el));
        next = activeIndex >= 0 ? items[activeIndex + 1] || null : null;
      }
    }

    return {
      container,
      items,
      total: items.length,
      done,
      next,
      trusted,
      source,
      diagnostics: { candidates, stateMarkers },
    };
  }

  /**
   * 按目录顺序取“当前项的下一项”，不依赖完成标记。
   * 当前项定位优先级：active 类名 → 页面标题命中 → 第一个未完成项的前一项。
   */
  function nextInOrder(profile = {}) {
    const result = scan(profile);
    if (!result || !result.items.length) return null;

    const items = result.items;
    const docTitle = String(doc.title || '');

    let index = items.findIndex((item) => isActiveItem(item.el));

    if (index < 0 && docTitle.length > 4) {
      index = items.findIndex((item) => {
        const key = item.title.slice(0, 12);
        return key.length >= 4 && docTitle.includes(key);
      });
    }

    if (index < 0) {
      const firstTodo = items.findIndex((item) => item.done === false);
      index = firstTodo > 0 ? firstTodo - 1 : -1;
    }

    if (index < 0 || index + 1 >= items.length) return null;
    return items[index + 1];
  }

  /** 调试用：列出候选目录容器与条目细节，便于一次性定位 */
  function inspect(profile = {}) {
    return allCandidates(profile).slice(0, 6).map(({ node, source }) => {
      const items = itemsOf(node);
      return {
        source,
        className: classOf(node).slice(0, 60),
        itemCount: items.length,
        stateMarkers: items.filter((item) => item.done !== null).length,
        sample: items.slice(0, 4).map((item) => `${item.done === true ? '✓' : item.done === false ? '·' : '?'} ${item.title}`),
        detail: items.slice(0, 4).map((item) => ({
          title: item.title,
          rowTag: String(item.el.tagName || '').toLowerCase(),
          rowClass: item.className,
          clickTag: item.clickTag,
          href: item.href,
          attrs: item.attrs,
          active: isActiveItem(item.el),
          done: item.done,
          hints: stateHintsOf(item.el),
        })),
      };
    });
  }

  function open(item) {
    if (!item) return false;

    const key = item.key || item.title || '';
    const tries = attempts.get(key) || 0;
    attempts.set(key, tries + 1);

    const targets = item.targets && item.targets.length ? item.targets : [item.clickEl || item.el].filter(Boolean);
    if (!targets.length) return false;

    const target = targets[tries % targets.length];
    return clickElement(target);
  }

  return { scan, nextInOrder, inspect, open };
}

// ---------- src/platforms/base.js ----------
/** 通用“下一节”文案，按平台差异可被 profile.next 精确选择器覆盖 */const NEXT_LABELS = ['下一节', '下一课', '下一讲', '下一集', '下一章', '下一课时', '下一个', '继续学习'];

/**
 * 基础适配器：所有平台共享的行为都在这里。
 * 平台差异由 profile（选择器/文案）与 quirk（特殊播放器）两层补齐。
 */function createBaseAdapter(profile, env) {
  const rateManager = env.rateManager || createRateManager();
  const document = env.document;

  return {
    id: profile.id,
    name: profile.name,
    profile,

    findVideo() {
      const videos = collectVideos(document).filter((video) => isVisibleMedia(video));
      if (!videos.length) return null;

      const ready = videos.filter((video) => {
        const info = readMedia(video);
        return info && info.ready && info.duration > 0;
      });
      const pool = ready.length ? ready : videos;
      return pool.find((video) => !video.paused && !video.ended) || pool[0];
    },

    applyRate(video, rate, options) {
      const result = rateManager.apply(video, rate, options || {});
      return { ...result, mode: 'native' };
    },

    restoreRate(video) {
      return rateManager.restore(video);
    },

    isSegmentDone(video, threshold) {
      const info = readMedia(video);
      if (!info) return false;
      if (info.duration > 0 && isFiniteNumber(threshold)
        && info.currentTime / info.duration >= threshold) return true;
      const markers = profile.done || [];
      return markers.length > 0 && !!findFirstVisible(document, markers);
    },

    /**
     * 只有视频处于暂停态才判定为“弹题阻断”，避免把常驻的答题入口误判成弹窗。
     */
    obstacle(video) {
      const info = readMedia(video);
      if (!info || !info.paused || info.ended) return null;

      const selectors = profile.obstacle || [];
      const el = findFirstVisible(document, selectors);
      if (!el) return null;

      const matched = selectors.find((selector) => {
        try {
          return typeof el.matches === 'function' && el.matches(selector);
        } catch {
          return false;
        }
      }) || '';

      return {
        type: 'quiz',
        selector: matched,
        label: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 32),
      };
    },

    next(options = {}) {
      // 用户指定过的元素优先，直接命中
      if (options && options.selector) {
        const custom = findFirstVisible(document, [options.selector]);
        if (custom) {
          clickElement(custom);
          return { el: custom, strategy: '自定义选择器' };
        }
      }

      const exact = findFirstVisible(document, profile.next || []);
      if (exact) {
        clickElement(exact);
        return { el: exact, strategy: '平台选择器' };
      }

      const byText = findByText(document, NEXT_LABELS);
      if (byText) {
        clickElement(byText);
        return { el: byText, strategy: '文案匹配' };
      }

      // 纯图标按钮：class / id / aria-label 里带 next
      const generic = findGenericNext(document);
      if (generic) {
        clickElement(generic);
        return { el: generic, strategy: 'next 类名' };
      }

      return null;
    },

    /** 调试：“下一节”点不动时，把页面上像按钮的元素列出来 */
    inspectNext() {
      const result = [];
      for (const el of queryAllDeep(document, 'button, a, [role="button"], [class*="next"], [class*="Next"], [class*="btn"]')) {
        const text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length > 20) continue;
        result.push({ text, className: String(el.className || '').slice(0, 48) });
        if (result.length >= 8) break;
      }
      return result;
    },

    describe() {
      return { id: profile.id, name: profile.name, quirk: profile.quirk };
    },
  };
}

// ---------- src/platforms/profiles.js ----------
/**
 * 平台矩阵：hosts 按域名后缀匹配，新增平台只需追加一条。
 * quirk: native = 标准 HTML5 video；xtplayer = 雨课堂/学堂在线 的 Vue 播放器。
 * reader: 图文/文档页的阅读容器选择器（命中即可自动滚动）。
 * download: 课件/附件入口选择器，找不到时按文件后缀兜底。
 * outline: 课程目录容器，用于定位“下一个未完成小节”。
 * listPages: 门户/列表页的 URL 路径片段——这些页面绝不按内容页托管
 *            （防止课程卡片/任务条目被误判成资料后触发“下一节”跳走）。
 */const PLATFORM_PROFILES = [
  {
    id: 'yuketang',
    name: '雨课堂',
    quirk: 'xtplayer',
    hosts: ['yuketang.cn'],
    listPages: ['/ci/web/index', '/web/list', '/web/myCourses', '/web/studentLog', '#tab/unfinished'],
    obstacle: ['.xt-popup', '.xt-exam-layer', '.question-wrap', '[class*="question-dialog"]'],
    next: ['.xt-next-btn', '[class*="next-video"]'],
    reader: ['.rich-text', '.markdown-body', '.lms-detail', '.xt-content'],
    download: ['.attach-list a', '.file-item a', '[class*="attachment"] a'],
    outline: [
      '.learning-space-student-chapter-nav .nav-item-list',
      '.learning-space-student .nav-item-list',
      '.nav-item-list',
      '[class*="chapter-nav"]',
      '[class*="nav-list"]',
      '.chapter-list',
      '.section-list',
      '.xt-video-list',
      '.lms-chapter',
    ],
    done: [],
    notes: 'Vue 播放器：倍速写入 xt-speedbutton 菜单；新版学习页无“下一节”按钮，按 .nav-item-leaf-box 目录顺序切换。',
  },
  {
    id: 'xuetangx',
    name: '学堂在线',
    quirk: 'xtplayer',
    hosts: ['xuetangx.com'],
    obstacle: ['.xt-popup', '.xt-exam-layer', '.question-wrap', '[class*="question-dialog"]'],
    next: ['.xt-next-btn', '[class*="next-video"]'],
    reader: ['.courseware-content', '.rich-text', '.markdown-body', '.xt-content'],
    download: ['.attach-list a', '.file-item a', '[class*="attachment"] a'],
    outline: ['.chapter-list', '.section-list', '.course-chapter', '.xt-course-chapter'],
    done: [],
    notes: '与雨课堂同源播放器；页面若未渲染 .xtplayer，会自动降级为原生倍速。',
  },
  {
    id: 'zhihuishu',
    name: '智慧树',
    quirk: 'native',
    hosts: ['zhihuishu.com'],
    obstacle: ['.examLayer', '.dialog-body', '.question-wrap', '[class*="question-dialog"]'],
    next: ['.next-btn', '.nextChapter'],
    reader: ['.text-content', '.article-content', '.study-content', '.course-content'],
    download: ['.file-list a', '.attach a', '[class*="download"] a'],
    outline: ['.chapter-list', '.catalog-list', '.section-list', '.chapters'],
    done: [],
    notes: '标准 video 元素；平台在标签页失焦时会暂停，需要保持窗口在前台，弹题出现时会暂停托管。',
  },
  {
    id: 'icve',
    name: '智慧职教',
    quirk: 'native',
    hosts: ['icve.com.cn'],
    obstacle: ['.el-dialog__wrapper', '.question-wrap', '[class*="question-dialog"]'],
    next: ['.next-btn', '.nextChapter'],
    reader: ['.el-main', '.content-box', '.article-content', '.courseware'],
    download: ['.file-list a', '.attach a', '[class*="download"] a'],
    outline: ['.el-menu', '.chapter-list', '.catalog-list'],
    done: [],
    notes: '播放器常位于同源 iframe 内，已由跨层探测覆盖；跨域 iframe 需油猴在同源域另行注入。',
  },
  {
    id: 'chaoxing',
    name: '超星学习通',
    quirk: 'native',
    hosts: ['chaoxing.com', 'xueyinonline.com'],
    obstacle: ['.TiMu', '.questionLi', '[class*="question-dialog"]'],
    next: ['.nextChapter', '#next'],
    reader: ['.richText', '.article-content', '.markdown-body', '#content'],
    download: ['.attachList a', '.annextitle a', '[class*="attach"] a'],
    outline: ['#chapterList', '.chapter-item', '.posCatalog_select', '.catalog_list'],
    done: ['.ans-job-icon.ans-job-finished'],
    notes: '任务点型课程，进度由播放器自行上报；脚本只在原速基础上加速，不做跳转。',
  },
  {
    id: 'icourse163',
    name: '中国大学MOOC',
    quirk: 'native',
    hosts: ['icourse163.org'],
    obstacle: ['.j-quiz', '.question-wrap', '[class*="question-dialog"]'],
    next: ['.next-btn', '.ux-mooc-next'],
    reader: ['.j-richText', '.course-content', '.m-textContent'],
    download: ['.j-attachment a', '.f-files a'],
    outline: ['.chapter', '.j-chapter', '.section-list'],
    done: [],
    notes: '标准 video 元素，直接使用原生倍速。',
  },
  {
    id: 'smartedu',
    name: '国家智慧教育平台',
    quirk: 'native',
    hosts: ['smartedu.cn'],
    obstacle: ['.question-wrap', '[class*="question-dialog"]'],
    next: ['.next-btn'],
    reader: ['.article-content', '.content-text', '.doc-content'],
    download: ['.resource-list a', '[class*="download"] a'],
    outline: ['.chapter-list', '.catalog-list'],
    done: [],
    notes: '标准 video 元素，默认按通用策略工作。',
  },
  {
    id: 'ouchn',
    name: '国家开放大学',
    quirk: 'native',
    hosts: ['ouchn.cn'],
    obstacle: ['.question-wrap', '[class*="question-dialog"]'],
    next: ['.next-btn'],
    reader: ['.content-body', '.article-content', '.text-content'],
    download: ['.file-list a', '[class*="download"] a'],
    outline: ['.chapter-list', '.course-catalog'],
    done: [],
    notes: '通用策略；若播放器为跨域 iframe，需要在 iframe 所在域单独放行。',
  },
];const GENERIC_PROFILE = {
  id: 'generic',
  name: '通用网页',
  quirk: 'native',
  hosts: [],
  listPages: [],
  obstacle: ['[class*="question-dialog"]', '.question-wrap', '.popup-quiz'],
  next: [],
  reader: ['article', '.article-content', '.rich-text', '.markdown-body', '.doc-content', '#js_content'],
  download: [],
  outline: [],
  done: [],
  notes: '未登记的平台按标准 HTML5 video 处理，可在面板中直接调速；图文页按通用阅读容器识别。',
};function matchProfile(href) {
  let hostname = '';
  try {
    hostname = new URL(String(href)).hostname.toLowerCase();
  } catch {
    hostname = '';
  }
  for (const profile of PLATFORM_PROFILES) {
    const hit = profile.hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
    if (hit) return profile;
  }
  return GENERIC_PROFILE;
}

// ---------- src/platforms/xtplayer.js ----------
const ACTIVE_CLASS = 'xt_video_player_common_active';
const state = new WeakMap();

/**
 * 雨课堂 / 学堂在线 的 Vue 播放器：倍速按钮是一个 <li data-speed>，
 * 播放器内部同时保存 options.speed.value 与 options.isDrag，两者不同步就会被重置。
 */function findXtPlayer(doc) {
  if (!doc || typeof doc.querySelectorAll !== 'function') return null;
  const found = [];

  for (const host of doc.querySelectorAll('.xtplayer')) {
    const vue = host.__vue__;
    const player = vue && vue.$data && vue.$data.player;
    const video = player && player.video;
    const options = player && player.options;
    const menu = host.querySelector('xt-speedbutton');
    const label = host.querySelector('xt-speedvalue');
    const items = menu ? Array.from(menu.querySelectorAll('li[data-speed]')) : [];

    if (!video || !menu || !label || !items.length || !options || !options.speed) continue;
    const duration = Number(video.duration);
    if (!Number.isFinite(duration) || duration <= 0) continue;

    found.push({ host, player, video, menu, label, items, options });
  }

  // 多个播放器同时存在时不做猜测，交给上层降级处理
  return found.length === 1 ? found[0] : null;
}

function tapMenu(menu, item) {
  const doc = menu.ownerDocument;
  const view = doc && doc.defaultView;
  const Ctor = view && view.MouseEvent;
  for (const type of ['mouseover', 'mousemove']) {
    if (typeof Ctor !== 'function') break;
    try {
      menu.dispatchEvent(new Ctor(type, { bubbles: true, clientX: 10, clientY: 30 }));
    } catch {
      /* 事件构造失败时仅保留 click */
    }
  }
  clickElement(item);
}

/**
 * 雨课堂新版学习页（/ai-workspace/lms-graph/...）：
 * 没有“下一节”按钮，课程列表是 .nav-item-leaf-box，当前小节的子节点带 is-active。
 * 返回 { boxes, activeIndex }，找不到列表或定位不到当前项时返回 null。
 */
function findYuketangLeafList(doc) {
  if (!doc || typeof doc.querySelectorAll !== 'function') return null;

  const boxes = Array.from(doc.querySelectorAll('.nav-item-leaf-box')).filter((box) => (
    box && typeof box.querySelector === 'function' && !!box.querySelector('.leaf-item, [class*="leaf"]')
  ));
  if (boxes.length < 2) return null;

  const activeIndex = boxes.findIndex((box) => {
    const leaf = box.firstElementChild;
    return (leaf && typeof leaf.classList.contains === 'function' && leaf.classList.contains('is-active'))
      || !!box.querySelector('.is-active');
  });

  return { boxes, activeIndex };
}const xtplayerQuirk = {
  findVideo(ctx) {
    const host = findXtPlayer(ctx.env.document);
    return host ? host.video : ctx.base.findVideo();
  },

  /**
   * 雨课堂新版学习页没有“下一节”按钮：
   * 自定义选择器 / 平台按钮 / 文案命中照旧，都没有时先按课程目录顺序点当前项的
   * 下一项，最后才退回 base 的“next 类名”盲猜，避免乱点一次导致双击。
   */
  next(ctx, options = {}) {
    const doc = ctx.env.document;

    if (options && options.selector) {
      const custom = findFirstVisible(doc, [options.selector]);
      if (custom) {
        clickElement(custom);
        return { el: custom, strategy: '自定义选择器' };
      }
    }

    const exact = findFirstVisible(doc, ctx.profile.next || []);
    if (exact) {
      clickElement(exact);
      return { el: exact, strategy: '平台选择器' };
    }

    const byText = findByText(doc, NEXT_LABELS);
    if (byText) {
      clickElement(byText);
      return { el: byText, strategy: '文案匹配' };
    }

    const list = findYuketangLeafList(doc);
    if (list && list.activeIndex >= 0 && list.activeIndex + 1 < list.boxes.length) {
      const target = list.boxes[list.activeIndex + 1];
      const leaf = (target && target.firstElementChild) || target;
      if (leaf) {
        clickElement(leaf);
        return { el: leaf, strategy: '雨课堂目录顺序' };
      }
    }

    const generic = findGenericNext(doc);
    if (generic) {
      clickElement(generic);
      return { el: generic, strategy: 'next 类名' };
    }

    return null;
  },

  applyRate(ctx, video, rate, options = {}) {
    const host = findXtPlayer(ctx.env.document);
    const jq = ctx.env.window && ctx.env.window.jQuery;
    if (!host || host.video !== video || typeof jq !== 'function') {
      return ctx.base.applyRate(video, rate, options);
    }

    if (!state.has(video)) {
      const active = host.items.find((item) => item.classList.contains(ACTIVE_CLASS)) || null;
      state.set(video, {
        speed: Number(host.options.speed.value),
        isDrag: host.options.isDrag,
        item: active,
        speedAttr: active ? active.getAttribute('data-speed') : null,
        keytAttr: active ? active.getAttribute('keyt') : null,
        text: active ? active.textContent : null,
      });
    }

    const target = host.items.find((item) => !item.classList.contains(ACTIVE_CLASS)) || host.items[0];

    try {
      if (target.classList.contains(ACTIVE_CLASS)) target.classList.remove(ACTIVE_CLASS);
      jq(target).data('speed', rate);
      target.setAttribute('data-speed', String(rate));
      target.setAttribute('keyt', rate.toFixed(2));
      target.textContent = `${rate.toFixed(2)}X`;
      tapMenu(host.menu, target);
      host.options.isDrag = true;

      const real = readRate(video);
      if (real === null || Math.abs(real - rate) > 0.01) throw new Error('播放器未接受该倍速');

      // 菜单接受后仍可能被播放器内部状态改回，突破模式下再补一层属性锁定
      if (options.enforce) {
        const locked = ctx.base.applyRate(video, rate, options);
        return {
          ok: true,
          real: locked.real === undefined || locked.real === null ? rate : locked.real,
          mode: 'xtplayer',
          enforced: locked.enforced === true,
        };
      }
      return { ok: true, real, mode: 'xtplayer' };
    } catch (error) {
      const fallback = ctx.base.applyRate(video, rate, options);
      if (fallback.ok) {
        return { ...fallback, mode: 'native-fallback', warning: '菜单写入失败，已回退原生倍速' };
      }
      return {
        ok: false,
        error: (error && error.message) || '倍速菜单写入失败',
        mode: 'xtplayer',
      };
    }
  },

  restoreRate(ctx, video) {
    const saved = state.get(video);
    state.delete(video);
    const result = ctx.base.restoreRate(video);

    const host = findXtPlayer(ctx.env.document);
    if (!saved || !host || host.video !== video) return result;

    const jq = ctx.env.window && ctx.env.window.jQuery;
    try {
      const item = saved.item;
      if (item && Number.isFinite(saved.speed)) {
        if (typeof jq === 'function') jq(item).data('speed', saved.speed);
        item.setAttribute('data-speed', String(saved.speed));
        if (saved.keytAttr !== null) item.setAttribute('keyt', saved.keytAttr);
        if (saved.text !== null) item.textContent = saved.text;
        tapMenu(host.menu, item);
      }
      host.options.isDrag = saved.isDrag;
      return { ...result, mode: 'xtplayer', restored: true, real: readRate(video) };
    } catch {
      return result;
    }
  },
};

// ---------- src/platforms/index.js ----------
const QUIRK_TABLE = {
  native: {},
  xtplayer: xtplayerQuirk,
};

/**
 * 组合 profile + quirk 生成适配器：
 * quirk 只覆盖它真正需要的几个方法，其余行为回落到 base。
 */function createAdapter(href, env) {
  const profile = matchProfile(href);
  const quirk = QUIRK_TABLE[profile.quirk] || QUIRK_TABLE.native;
  const base = createBaseAdapter(profile, env);
  const adapter = { ...base };

  for (const key of Object.keys(quirk)) {
    adapter[key] = (...args) => quirk[key]({ base, env, profile }, ...args);
  }

  /** 平台声明的门户/列表页：这类 URL 不参与内容托管，引擎只做目录跳转。
   *  用 路径 + hash 匹配（如雨课堂任务列表 /web/study?...#tab/unfinished）。 */
  adapter.isListPage = () => {
    try {
      const target = String(env.location.pathname || '') + String(env.location.hash || '');
      return (profile.listPages || []).some((pattern) => !!pattern && target.includes(pattern));
    } catch {
      return false;
    }
  };

  return adapter;
}

// ---------- src/engine.js ----------
const PHASE_MESSAGE = {
  idle: '待机',
  searching: '正在查找页面中的视频…',
  running: '加速播放中',
  reading: '图文阅读中',
  blocked: '检测到弹题，托管已暂停',
  finished: '本节已完成',
  done: '本课程已完成',
  disabled: '托管已关闭',
  error: '运行异常',
};

const SEEK_TOLERANCE = 3; // 单次轮询的最小推进容差，实际阈值随耗时与倍率浮动
const STALL_SECONDS = 3; // 连续无推进超过该秒数判定为卡顿

/** 降档阶梯：高倍速下解码/带宽跟不上时按这个顺序回退 */
const DEGRADE_STEPS = [16, 12, 10, 8, 5, 4, 3, 2, 1.5, 1];

function nextLowerSpeed(speed) {
  return DEGRADE_STEPS.find((step) => step < speed - 0.01) || null;
}

function attempt(fn, fallback) {
  try {
    return fn();
  } catch (error) {
    return typeof fallback === 'function' ? fallback(error) : fallback;
  }
}

/**
 * 托管引擎：只调整播放节奏，不写接口、不改记录、不做跳转。
 * 所有副作用都可从 state 与日志回溯。
 */function createEngine({ config, logger, env }) {
  const subscribers = new Set();
  const session = { watched: 0, readSec: 0, wall: 0, segments: 0, switches: 0, startedAt: 0 };

  const state = {
    phase: 'idle',
    message: PHASE_MESSAGE.idle,
    mode: 'idle',
    content: 'idle',
    target: config.get().speed,
    stalledSec: 0,
    platform: { id: 'generic', name: '通用网页', host: '' },
    video: null,
    document: null,
    materials: { count: 0, downloaded: 0 },
    outline: { total: 0, done: 0, next: '' },
  };

  let running = false;
  let timer = null;
  let adapter = null;
  let href = '';
  let video = null;
  let track = null;
  let lastRateErrorAt = 0;
  let lastObstacleLogAt = 0;
  let lastResumeLogAt = 0;
  let lastAdaptAt = 0;
  let lastStallLogAt = 0;

  const reader = env.reader || createReader(env);
  const outline = env.outline || createOutline(env);
  const materialFinder = typeof env.findMaterials === 'function' ? env.findMaterials : findMaterials;
  let outlineInfo = null;
  let lastOutlineScanAt = 0;
  let lastOutlineLogAt = 0;
  let lastJumpAt = 0;
  let lastJumpKey = '';
  let jumpCooldownUntil = 0;
  let lastPdfLogAt = 0;
  let pickingNext = false;
  let pendingJump = null;
  let pendingNext = null;
  let pdfReadSec = 0;
  let pdfLastAt = 0;
  let pdfDone = false;
  let pdfNextAt = 0;
  let docTrack = { target: null, lastAt: 0, done: false, nextAt: 0 };
  let materials = [];
  let lastMaterialScanAt = 0;
  let lastDownloadAt = 0;
  const clickedMaterials = new Set();
  let materialSignature = '';
  let materialPageDone = false;
  let materialNextAt = 0;
  let materialReadSec = 0;
  let materialLastAt = 0;
  let materialPreviewOpened = false;

  const now = () => (typeof env.now === 'function' ? env.now() : Date.now());

  function getState() {
    return {
      phase: state.phase,
      message: state.message,
      mode: state.mode,
      content: state.content,
      enabled: config.get().enabled,
      target: state.target,
      stalledSec: state.stalledSec,
      platform: { ...state.platform },
      video: state.video ? { ...state.video } : null,
      document: state.document ? { ...state.document } : null,
      materials: { ...state.materials },
      outline: { ...state.outline },
      running,
      session: {
        ...session,
        effective: session.wall > 0 ? session.watched / session.wall : 0,
      },
    };
  }

  function emit() {
    const snapshot = getState();
    for (const listener of subscribers) {
      try {
        listener(snapshot);
      } catch {
        /* 单个订阅者异常不影响引擎 */
      }
    }
    return snapshot;
  }

  function resetTrack(info) {
    track = {
      src: info && info.src ? info.src : '',
      lastTime: info ? info.currentTime : 0,
      lastAt: now(),
      done: false,
      nextAt: 0,
      lastProgressAt: now(),
      fallbackLogged: false,
      lockLogged: false,
      muteLogged: false,
    };
  }

  function describeVideo(info) {
    const percent = info.duration > 0 ? Math.min(1, info.currentTime / info.duration) : 0;
    return {
      current: info.currentTime,
      duration: info.duration,
      percent,
      rate: info.rate,
      paused: info.paused,
      ended: info.ended,
      ready: info.ready,
    };
  }

  function setPhase(phase, message) {
    state.phase = phase;
    state.message = message || PHASE_MESSAGE[phase] || '';
  }

  /** 从目录项上找节点 id（雨课堂用 node_id 定位小节） */
  function nodeIdOf(item) {
    const el = item && item.el;
    if (!el || typeof el.getAttribute !== 'function') return '';

    const pick = (node) => node && (node.getAttribute('node_id') || node.getAttribute('data-node-id')
      || node.getAttribute('nodeid') || node.getAttribute('data-id'));
    const direct = pick(el);
    if (direct) return String(direct);

    if (typeof el.closest === 'function') {
      const host = el.closest('[node_id], [data-node-id], [nodeid], [data-id]');
      if (host) return String(pick(host) || '');
    }
    return '';
  }

  /** 跳转后校验：点了没反应就改用链接直达 */
  function checkPendingJump() {
    if (!pendingJump) return;

    const currentHref = String(env.location.href || '');
    const currentTitle = String(env.document.title || '');
    if (currentHref !== pendingJump.href || currentTitle !== pendingJump.title) {
      pendingJump = null;
      return;
    }
    if (now() - pendingJump.at < 2500) return;

    if (!pendingJump.triedHref) {
      pendingJump.triedHref = true;

      const win = env.window;
      const canAssign = !!(win && win.location && typeof win.location.assign === 'function');
      const item = pendingJump.item;

      // 1) 目录项自带真实 href → 直接导航
      const rawHref = item && item.href;
      // 只对看起来是课时内容的链接兜底直达（防把首页/列表链接当课时跳过去）
      const href = rawHref && !/^javascript:/i.test(rawHref) && !rawHref.startsWith('#')
        && /(ai-workspace|\/video|\/study|lesson_id|content_id|node_id|\/lms|\/learning)/i.test(rawHref)
        ? rawHref : '';
      if (href && canAssign) {
        try {
          win.location.assign(new URL(href, currentHref).href);
          logger.info(`点击目录项没反应，改用链接直达：${item.title}`);
          return;
        } catch {
          /* 继续尝试下一种 */
        }
      }

      // 2) 雨课堂这类 SPA 用 node_id 定位小节 → 改写当前地址
      const nodeId = nodeIdOf(item);
      if (nodeId && canAssign) {
        try {
          const url = new URL(currentHref);
          if (url.searchParams.has('node_id')) {
            url.searchParams.set('node_id', nodeId);
            win.location.assign(url.href);
            logger.info(`点击无效，按 node_id 改写地址跳转：${item.title}`);
            return;
          }
        } catch {
          /* 落到告警 */
        }
      }

      logger.warn(`跳到「${item ? item.title : '未知'}」后页面没有变化，该目录项可能需要点击整行`);
      pendingJump = null;
    }
  }

  /** 当前播放源地址，用于判断“下一节”点击后页面是否真的换了内容 */
  function currentVideoSrc() {
    if (!video) return '';
    return String((video.currentSrc || video.src) || '');
  }

  /**
   * “下一节”点击后的校验：SPA（雨课堂新版学习页）点了没反应时不再干等，
   * 4 秒内 URL / 标题 / 视频源都没变就降级为课程目录跳转。
   */
  function checkPendingNext(cfg) {
    if (!pendingNext) return;

    const hrefChanged = String(env.location.href || '') !== pendingNext.href;
    const titleChanged = String(env.document.title || '') !== pendingNext.title;
    const srcChanged = currentVideoSrc() !== pendingNext.src;
    if (hrefChanged || titleChanged || srcChanged) {
      pendingNext = null;
      return;
    }
    if (now() - pendingNext.at < 4000) return;

    const strategy = pendingNext.strategy || '按钮';
    pendingNext = null;
    logger.warn(`点击“下一节”（${strategy}）后页面没有变化，改用课程目录跳转`);

    if (cfg.autoJump && jumpToNextUnfinished(cfg, '下一节按钮无效')) return;

    const ordered = attempt(() => outline.nextInOrder(adapter.profile || {}), null);
    if (ordered && attempt(() => outline.open(ordered), false)) {
      session.switches += 1;
      resetTrack(null);
      docTrack = { target: null, lastAt: now(), done: false, nextAt: 0 };
      setPhase('searching', `正在跳到下一节：${ordered.title}`);
      logger.info(`按目录顺序跳到下一节：${ordered.title}`);
      return;
    }

    if (isCourseDone(cfg)) {
      setPhase('done', '本课程已完成');
      logger.info('课程已全部完成，不再切换');
    } else {
      setPhase('finished', '“下一节”点了没反应，请手动切换或点面板「诊断」');
    }
  }

  function tick() {
    const cfg = config.get();
    state.target = cfg.speed;

    const currentHref = String(env.location.href || '');
    if (currentHref !== href || !adapter) {
      href = currentHref;
      adapter = env.adapterFor(currentHref);
      let host = '';
      try {
        host = new URL(currentHref).hostname;
      } catch {
        host = '';
      }
      state.platform = { id: adapter.id, name: adapter.name, host };
      // reader 通过 env.profile 读取平台专属阅读容器选择器
      env.profile = adapter.profile;
      video = null;
      resetTrack(null);
      materials = [];
      clickedMaterials.clear();
      materialSignature = '';
      materialPageDone = false;
      materialNextAt = 0;
      materialReadSec = 0;
      materialLastAt = 0;
      materialPreviewOpened = false;
      lastMaterialScanAt = 0;
      pdfReadSec = 0;
      pdfLastAt = 0;
      pdfDone = false;
      pdfNextAt = 0;
      pendingJump = null;
      pendingNext = null;
      logger.info(`平台适配：${adapter.name}`);
    }

    // 即使暂停托管也完成平台识别，避免面板一直显示“通用网页”
    if (!cfg.enabled) {
      setPhase('disabled', '托管已关闭');
      state.video = null;
      return emit();
    }

    checkPendingJump();
    checkPendingNext(cfg);

    // 目录状态每 3 秒刷新一次，面板在任何内容类型下都能显示“下一节未完成”
    refreshOutline(cfg);

    const found = attempt(() => adapter.findVideo(), null);
    if (!found) {
      state.video = null;
      video = null;
      return tickDocument(cfg);
    }

    state.mode = 'video';
    state.content = 'video';
    state.document = null;

    const info = readMedia(found);
    if (!info || !info.ready) {
      // 有些图文页会留一个没加载的视频占位，等不到就切回图文/资料识别
      if (cfg.documentMode && attempt(() => reader.canRead(), false)) return tickDocument(cfg);
      setPhase('searching', '视频尚未就绪…');
      return emit();
    }

    if (found !== video) {
      video = found;
      resetTrack(info);
      logger.info('已锁定视频，开始托管');
    } else if (track && info.src && track.src && info.src !== track.src) {
      resetTrack(info);
      logger.info('视频源已切换，重新计时');
    }

    state.video = describeVideo(info);

    // 1. 倍速下发 / 被平台重置后自动补写
    const target = cfg.speed;
    if (!isFiniteNumber(info.rate) || Math.abs(info.rate - target) > 0.01) {
      const result = attempt(
        () => adapter.applyRate(found, target, { enforce: cfg.breakthrough }),
        { ok: false, error: '倍速接口异常' },
      );
      if (!result || !result.ok) {
        setPhase('error', (result && result.error) || '倍速写入失败');
        if (now() - lastRateErrorAt > 5000) {
          logger.warn(`倍速设置失败：${state.message}`);
          lastRateErrorAt = now();
        }
        return emit();
      }
      if (result.mode === 'native-fallback' && !track.fallbackLogged) {
        track.fallbackLogged = true;
        logger.warn(result.warning || '已回退到原生倍速');
      }
      if (result.enforced && !track.lockLogged) {
        track.lockLogged = true;
        logger.info(`已突破平台上限并锁定 ${formatRate(target)}，平台改回原速会被拦截`);
      }
      if (target > RATE_AUDIBLE_MAX && !track.muteLogged) {
        track.muteLogged = true;
        logger.warn(`${formatRate(target)} 下浏览器会自动静音，属正常现象`);
      }
    }

    // 2. 弹题阻断：暂停所有自动动作，等人工处理
    const obstacle = cfg.pauseOnObstacle ? attempt(() => adapter.obstacle(found), null) : null;
    if (obstacle) {
      setPhase('blocked', obstacle.label ? `弹题中断：${obstacle.label}` : '检测到弹题，等待人工处理');
      if (now() - lastObstacleLogAt > 5000) {
        lastObstacleLogAt = now();
        logger.warn('检测到弹题/答题弹窗，托管已暂停，处理后自动继续');
      }
      return emit();
    }

    // 3. 自动续播（浏览器的自动播放策略可能拒绝，只提示不重试轰炸）
    if (cfg.autoResume && info.paused && !info.ended && !info.seeking) {
      const played = attempt(() => found.play(), null);
      if (played && typeof played.catch === 'function') {
        played.catch(() => {
          if (now() - lastResumeLogAt > 15000) {
            lastResumeLogAt = now();
            logger.warn('浏览器阻止自动播放，请手动点击一次播放');
          }
        });
      }
    }

    // 4. 观看时长统计：只累计正常播放推进，拖动/跳转不计入
    const playing = !info.paused && !info.ended && !info.seeking;
    const delta = track ? info.currentTime - track.lastTime : 0;
    if (track) {
      const elapsed = track.lastAt ? Math.max(0, (now() - track.lastAt) / 1000) : 0;
      const effective = isFiniteNumber(info.rate) && info.rate > 0 ? info.rate : target;
      // 允许的推进上限随“实际耗时 × 当前倍率”浮动，兼顾高倍速与定时器抖动
      const budget = Math.max(SEEK_TOLERANCE, elapsed * effective * 3);
      if (playing && delta > 0 && delta <= budget) session.watched += delta;
      if (playing) session.wall += elapsed;
      // 播放中且时间轴有推进才刷新停滞计时；暂停/缓冲不算卡顿
      if (!playing || delta > 0.05) track.lastProgressAt = now();
      track.lastTime = info.currentTime;
      track.lastAt = now();
    }

    // 5. 卡顿检测：高倍速下解码/带宽跟不上时，按阶梯自动降档而不是干等
    const stalledSec = playing && track ? Math.round((now() - track.lastProgressAt) / 1000) : 0;
    state.stalledSec = stalledSec;
    if (stalledSec >= STALL_SECONDS) {
      const lowered = cfg.adaptive ? nextLowerSpeed(cfg.speed) : null;
      if (lowered && now() - lastAdaptAt > 6000) {
        lastAdaptAt = now();
        logger.warn(`播放停滞 ${stalledSec}s，已自动从 ${formatRate(cfg.speed)} 降到 ${formatRate(lowered)}`);
        config.set({ speed: lowered });
        setPhase('running', `卡顿降档 ${formatRate(lowered)}（原 ${formatRate(cfg.speed)}）`);
        return emit();
      }
      if (!lowered && now() - lastStallLogAt > 8000) {
        lastStallLogAt = now();
        logger.warn(`播放停滞 ${stalledSec}s：${formatRate(cfg.speed)} 需要每秒解码 ${cfg.speed} 秒内容，多为缓冲或解码跟不上`);
      }
    }

    // 6. 完成判定与自动下一节
    const ratio = info.duration > 0 ? info.currentTime / info.duration : 0;
    const done = ratio >= cfg.completeThreshold
      || attempt(() => adapter.isSegmentDone(found, cfg.completeThreshold), false);

    if (done && track && !track.done) {
      track.done = true;
      session.segments += 1;
      logger.info(`本节完成：${formatPercent(ratio)}%`);
      if (cfg.autoNext) track.nextAt = now() + cfg.nextDelayMs;
      setPhase('finished', `本节已完成（${formatPercent(ratio)}%）`);
    } else if (track && track.done && cfg.autoNext && track.nextAt && now() >= track.nextAt) {
      track.nextAt = 0;
      if (goNext(cfg, '无下一节按钮')) {
        /* 已发起切换，checkPendingNext 会校验是否真的切过去了 */
      } else if (isCourseDone(cfg)) {
        setPhase('done', '本课程已完成');
        logger.info('课程已全部完成，不再切换');
      } else {
        setPhase('finished', '未找到“下一节”入口，请手动切换');
        logger.warn('未找到“下一节”入口，请手动切换');
      }
    } else if (!track || !track.done) {
      if (playing) setPhase('running', `加速播放中 · ${formatRate(target)}`);
      else if (info.ended) setPhase('finished', '视频已播放结束');
      else if (info.paused) setPhase('running', '视频已暂停');
      else setPhase('running', '缓冲中…');
    }

    return emit();
  }

  /** 扫描课程目录，缓存「下一个未完成小节」（3 秒节流） */
  function refreshOutline(cfg) {
    if (now() - lastOutlineScanAt < 3000) return outlineInfo;
    lastOutlineScanAt = now();

    const profile = adapter && adapter.profile ? adapter.profile : {};
    const result = attempt(() => outline.scan(profile), null);
    if (result) {
      outlineInfo = result;
      state.outline = {
        total: result.total,
        done: result.done,
        next: result.next ? result.next.title : '',
      };
    } else {
      outlineInfo = null;
      state.outline = { total: 0, done: 0, next: '' };
      if (now() - lastOutlineLogAt > 30000) {
        lastOutlineLogAt = now();
        const candidates = attempt(() => outline.inspect(profile), []) || [];
        logger.info(`未识别到课程目录：候选容器 ${candidates.length} 个，均无可用完成标记`);
      }
    }
    return outlineInfo;
  }

  /** 目录全部完成 = 课程终点，绝不能再去点“返回/退出”一类元素 */
  function isCourseDone(cfg) {
    const info = refreshOutline(cfg);
    return !!(info && info.total > 0 && !info.next);
  }

  function jumpToNextUnfinished(cfg, reason = '') {
    // 跳转后给页面一段稳定时间，避免刚落地又被判定为“列表页”而重复点击
    if (now() < jumpCooldownUntil) return false;

    const info = refreshOutline(cfg);
    if (!info || !info.next) return false;
    if (now() - lastJumpAt < 8000) return false;
    // 同一小节 10 秒后可再试；配合 outline.open 的目标轮换，每次换一个元素点
    if (info.next.key === lastJumpKey && now() - lastJumpAt < 10000) return false;

    lastJumpAt = now();
    lastJumpKey = info.next.key;
    jumpCooldownUntil = now() + 8000;
    const opened = attempt(() => outline.open(info.next), false);
    if (opened) {
      const tag = info.next.clickTag || 'element';
      logger.info(`跳到未完成小节：${info.next.title}（点击 ${tag}${reason ? ` · ${reason}` : ''}）`);
      pendingJump = {
        key: info.next.key,
        href: String(env.location.href || ''),
        title: String(env.document.title || ''),
        at: now(),
        item: info.next,
        triedHref: false,
      };
      setPhase('reading', `正在跳到未完成：${info.next.title}`);
    }
    return opened;
  }

  /**
   * 用户拾取的“下一节”选择器按域名作用域（存成 "host|selector"），
   * 避免在 A 站挑的按钮被拿到 B 站乱点；旧格式字符串（无 | ）仍全局生效。
   */
  function scopedNextSelector(cfg) {
    const raw = String(cfg.nextSelector || '');
    const sep = raw.indexOf('|');
    if (sep <= 0) return raw;
    const host = String((env.location && env.location.host) || '');
    return host && raw.slice(0, sep) === host ? raw.slice(sep + 1) : '';
  }

  /**
   * 任务列表页守卫：一屏冒出多个“资料/附件”链接、且页面充满
   * “未开始 / 未完成 / 未学习”标记时，这是任务列表而不是资料正文页。
   * 这种页面不计时、不点下一节，只按目录跳未读小节。
   */
  function isMaterialListPage() {
    const body = env.document.body;
    const text = String((body && body.textContent) || '');
    const markers = (text.match(/未开始|未完成|未学习|未读/g) || []).length;
    if (materials.length >= 4 && markers >= 4) return true;
    // 页面充满“未开始/未读”标记时按列表页处理，除非资料里至少有一条
    // 带真实文件后缀的链接（真资料页的形态）——防止任务列表被当资料托管
    if (markers >= 6) {
      const strong = materials.some((item) => attempt(() => (
        /\.(pdf|docx?|pptx?|xlsx?|zip|rar|7z|mp4)(\?|#|$)/i.test(
          String((item.el.getAttribute && item.el.getAttribute('href')) || ''),
        )
      ), false));
      return !strong;
    }
    return false;
  }

  /** 统一的“切下一节”入口：下一节按钮 → 未完成小节 → 目录顺序，点完都做导航校验 */
  function goNext(cfg, reason = '') {
    const clicked = attempt(() => adapter.next({ selector: scopedNextSelector(cfg) }), null);
    if (clicked) {
      session.switches += 1;
      resetTrack(null);
      docTrack = { target: null, lastAt: now(), done: false, nextAt: 0 };
      setPhase('searching', '正在加载下一节…');
      pendingNext = {
        at: now(),
        href: String(env.location.href || ''),
        title: String(env.document.title || ''),
        src: currentVideoSrc(),
        strategy: (clicked && clicked.strategy) || '按钮',
      };
      logger.info(`已点击“下一节”（${pendingNext.strategy}），等待页面响应`);
      return true;
    }

    if (cfg.autoJump && jumpToNextUnfinished(cfg, reason)) {
      resetTrack(null);
      return true;
    }

    const ordered = attempt(() => outline.nextInOrder(adapter.profile || {}), null);
    if (ordered && attempt(() => outline.open(ordered), false)) {
      session.switches += 1;
      resetTrack(null);
      docTrack = { target: null, lastAt: now(), done: false, nextAt: 0 };
      setPhase('searching', `正在跳到下一节：${ordered.title}`);
      logger.info(`按目录顺序跳到下一节：${ordered.title}（点击 ${ordered.clickTag || 'element'}）`);
      return true;
    }

    return false;
  }

  let lastListRowAt = 0;
  let lastExpandAt = 0;
  const listRowFails = new Map();

  /** 元素自身的直接文本（不含子元素） */
  function ownText(el) {
    return attempt(() => Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => String(n.nodeValue || '').trim())
      .join(''), '');
  }

  /** 标记是否位于导航/筛选控件里（比如“未完成”筛选 tab） */
  function markerInNav(marker) {
    return attempt(() => {
      let p = marker.parentElement;
      for (let i = 0; i < 3 && p; i++) {
        if (/tab|nav|menu|filter|header|switch/i.test(String(p.className || ''))) return true;
        p = p.parentElement;
      }
      return false;
    }, true);
  }

  /** 从标记向上找可点击的任务行容器：文本量可控，且带链接或可点击语义 */
  function findListRow(marker, doc) {
    return attempt(() => {
      let p = marker;
      for (let i = 0; i < 6 && p && p !== doc.body; i++) {
        p = p.parentElement;
        if (!p || (p.closest && p.closest('#coursepilot-host'))) return null;
        if (String(p.textContent || '').length > 300) return null;
        const link = p.querySelector ? p.querySelector('a[href]') : null;
        const cls = String(p.className || '');
        const clickable = link
          || /item|row|task|lesson|card|exercise/i.test(cls)
          || (p.getAttribute && (p.getAttribute('onclick') || p.getAttribute('role') === 'button'));
        if (clickable) return { el: p, link };
      }
      return null;
    }, null);
  }

  /**
   * 任务/日志列表页兜底：页面没有章节目录时，直接点进列表条目。
   * 两轮扫描：
   *  1) “未开始 / 未读”状态标记 → 未完成任务行（雨课堂“未完成”页）
   *  2) “视频 / 图文 / 文档”内容角标 → 学习日志条目（雨课堂“学习日志”页，
   *     没有状态标记，只有内容类型角标；点进去后由引擎按目录推进未完成项）
   * 点完交给 checkPendingJump 校验，没跳成再试链接直达。
   */
  function listRowJump(cfg, reason = '') {
    if (!cfg.autoJump) return false;
    if (now() - lastListRowAt < 12000) return false;
    const doc = env.document;
    if (!doc || typeof doc.querySelectorAll !== 'function') return false;

    // 折叠的模块先展开（开关文字是“展开”）：展开后下一轮再点里面的条目
    if (now() - lastExpandAt > 8000) {
      for (const el of doc.querySelectorAll('body *')) {
        const own = ownText(el);
        if (!/^(展开|点击展开|展开模块)$/.test(own)) continue;
        if (!attempt(() => !!(el.offsetParent || (el.getClientRects && el.getClientRects().length)), false)) continue;
        if (markerInNav(el)) continue;
        if (el.closest && el.closest('#coursepilot-host')) continue;
        lastExpandAt = now();
        attempt(() => clickElement(el), false);
        setPhase('searching', '正在展开课程模块…');
        logger.info(`展开课程模块：${String((el.parentElement && el.parentElement.textContent) || own).replace(/\s+/g, ' ').trim().slice(0, 40)}`);
        return true;
      }
    }

    const passes = [
      /^(未开始|未读|未完成|未学习)$/,
      /^(视频|图文|文档|课件|资料)$/,
    ];

    for (const pattern of passes) {
      for (const marker of doc.querySelectorAll('body *')) {
        if (!pattern.test(ownText(marker))) continue;
        // 隐藏元素（折叠模块里的条目）点不动，跳过
        if (!attempt(() => !!(marker.offsetParent || (marker.getClientRects && marker.getClientRects().length)), false)) continue;
        if (markerInNav(marker)) continue;

        const row = findListRow(marker, doc);
        if (!row) continue;

        const title = attempt(() => String(row.el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60), '列表条目');
        // 作业/考试等考核类条目没法自动完成，跳过
        if (/^作业|^考试|^测验|^问卷|^投票|考核截止时间/.test(title)) continue;
        const key = attempt(() => (row.link ? String(row.link.getAttribute('href') || '') : '') || title, title) || title;
        const failedAt = listRowFails.get(key);
        if (failedAt && now() - failedAt < 60000) continue;

        lastListRowAt = now();
        const clicked = attempt(() => clickElement(row.link || row.el), false);
        if (!clicked) {
          listRowFails.set(key, now());
          continue;
        }

        session.switches += 1;
        resetTrack(null);
        docTrack = { target: null, lastAt: now(), done: false, nextAt: 0 };
        setPhase('searching', `正在进入任务：${title}`);
        logger.info(`点进列表条目：${title}${reason ? `（${reason}）` : ''}`);
        pendingJump = {
          item: { title, href: attempt(() => (row.link ? String(row.link.getAttribute('href') || '') : ''), '') },
          href: String(env.location.href || ''),
          title: String(env.document.title || ''),
          at: now(),
        };
        return true;
      }
    }
    return false;
  }

  /** 内容自动识别：视频优先，其次图文，最后资料页 */
  function tickDocument(cfg) {
    state.mode = 'document';

    // 平台声明的门户/列表页：绝不按内容页托管（课程卡片 / 任务条目会被
    // 误判成资料，计时结束后点“下一节”把页面带走），只保留目录跳转
    if (attempt(() => adapter.isListPage(), false)) {
      materials = [];
      materialSignature = '';
      state.materials = { count: 0, downloaded: clickedMaterials.size, readSec: 0, goal: cfg.materialReadSec };
      state.content = 'unknown';
      state.document = null;

      // 列表页没有真实课程目录，绝不跑目录扫描（会扫到 tab 栏等垃圾并误点
      // 把页面带走），只直接点列表条目（先展开模块，再点未开始/角标行）
      if (cfg.autoJump && listRowJump(cfg, '列表页任务')) return emit();
      setPhase('searching', '列表页 · 请进入具体课程/小节后再托管');
      return emit();
    }

    if (now() - lastMaterialScanAt > 2000) {
      lastMaterialScanAt = now();
      const profile = adapter && adapter.profile ? adapter.profile : {};
      materials = attempt(() => materialFinder(env.document, profile), []) || [];
      state.materials = {
        count: materials.length,
        downloaded: clickedMaterials.size,
        readSec: Math.round(materialReadSec),
        goal: cfg.materialReadSec,
      };

      const signature = materials.map((item) => item.key).join('|');
      if (signature !== materialSignature) {
        materialSignature = signature;
        materialPageDone = false;
        materialNextAt = 0;
        materialReadSec = 0;
        materialLastAt = now();
        materialPreviewOpened = false;
      }
    }

    if (cfg.autoDownload) autoDownloadTick();

    const target = cfg.documentMode ? attempt(() => reader.find(), null) : null;
    const info = target ? attempt(() => reader.metrics(target), null) : null;
    const readable = !!(info && attempt(() => reader.canRead(), false));

    // PDF 预览：浏览器内置阅读器没法用脚本滚动，改为“停留计时”计入已读
    const pdfViewer = attempt(() => findPdfViewer(env.document), null);
    if (!readable && pdfViewer) {
      state.content = 'document';

      const elapsed = pdfLastAt ? Math.max(0, (now() - pdfLastAt) / 1000) : 0;
      pdfLastAt = now();
      if (!pdfDone) pdfReadSec += elapsed;

      const goal = cfg.materialReadSec;
      state.document = {
        ratio: Math.min(1, pdfReadSec / goal),
        atBottom: false,
        textLength: 0,
        pxPerSec: 0,
        pdf: true,
      };

      if (pdfReadSec < goal) {
        if (now() - lastPdfLogAt > 30000) {
          lastPdfLogAt = now();
          logger.warn('检测到 PDF 预览：浏览器内置阅读器无法滚动，按停留时长计为已读');
        }
        setPhase('reading', `PDF 预览 · ${Math.round(pdfReadSec)}/${goal}s`);
        return emit();
      }

      if (!pdfDone) {
        pdfDone = true;
        session.segments += 1;
        logger.info(`PDF 预览停留 ${goal}s，计为已读`);
        if (cfg.autoNext) pdfNextAt = now() + cfg.nextDelayMs;
      }

      if (cfg.autoNext && pdfNextAt && now() >= pdfNextAt) {
        pdfNextAt = 0;
        if (goNext(cfg, 'PDF 之后')) {
          setPhase('reading', '正在加载下一节…');
        } else if (isCourseDone(cfg)) {
          setPhase('done', '本课程已完成');
          logger.info('课程已全部完成，不再切换');
        } else {
          setPhase('finished', 'PDF 已读完，未找到下一节入口');
        }
        return emit();
      }

      setPhase('finished', `PDF 预览已读（停留 ${goal}s）`);
      return emit();
    }

    // 列表页判定：整页可滚动 + 目录里还有未读项 + 当前不是平台声明的正文容器
    // 这种情况应进入未读小节，而不是傻滚列表页
    if (readable && cfg.autoJump && info.isRoot && !info.explicit) {
      const outlineState = refreshOutline(cfg);
      const nextTitle = outlineState && outlineState.next ? outlineState.next.title : '';
      const pageTitle = String(env.document.title || '');
      const alreadyHere = nextTitle && pageTitle && pageTitle.includes(nextTitle.slice(0, 10));
      if (nextTitle && !alreadyHere && jumpToNextUnfinished(cfg, '列表页有未读项')) return emit();
    }

    if (readable) {
      state.content = 'document';
      return runReaderTick(cfg, info);
    }

    if (materials.length > 0 && !isMaterialListPage()) {
      state.content = 'material';
      return runMaterialTick(cfg);
    }

    state.content = 'unknown';
    state.document = null;

    const outlineState = refreshOutline(cfg);
    if (outlineState && outlineState.total > 0 && !outlineState.next) {
      setPhase('done', '本课程已完成');
      logger.info('课程目录已全部完成，停止自动切换');
      return emit();
    }
    if (cfg.autoJump && jumpToNextUnfinished(cfg, '当前页无内容')) return emit();
    if (listRowJump(cfg, '无内容页')) return emit();

    setPhase('searching', cfg.documentMode ? '等待视频、图文或资料…' : '未发现视频（图文阅读已关闭）');
    return emit();
  }

  function autoDownloadTick() {
    // 列表页守卫：任务列表里的条目链接不是资料，不能逐个点开
    if (isMaterialListPage()) return;
    if (now() - lastDownloadAt <= 1500) return;
    const pending = materials.find((item) => !clickedMaterials.has(item.key));
    if (!pending) return;
    lastDownloadAt = now();
    clickedMaterials.add(pending.key);
    attempt(() => clickElement(pending.el), false);
    state.materials = { count: materials.length, downloaded: clickedMaterials.size };
    logger.info(`已触发资料下载：${pending.label}`);
  }

  function runReaderTick(cfg, info) {
    if (!docTrack.target || docTrack.target !== info.target) {
      docTrack = { target: info.target, lastAt: now(), done: false, nextAt: 0 };
    }
    // SPA 换页后滚动条回到顶部，重置“本节已读完”
    if (docTrack.done && info.scrollTop < 80) docTrack.done = false;

    const elapsed = docTrack.lastAt ? Math.max(0, (now() - docTrack.lastAt) / 1000) : 0;
    docTrack.lastAt = now();

    const pxPerSec = Math.round(READ_BASE_PX * cfg.speed);
    state.document = {
      ratio: info.ratio,
      atBottom: info.atBottom,
      textLength: info.textLength,
      pxPerSec,
    };

    if (info.atBottom) {
      if (!docTrack.done) {
        docTrack.done = true;
        session.segments += 1;
        logger.info(`图文已读完：${formatPercent(info.ratio)}%`);
        if (cfg.autoNext) docTrack.nextAt = now() + cfg.nextDelayMs;
      }

      if (cfg.autoNext && docTrack.nextAt && now() >= docTrack.nextAt) {
        docTrack.nextAt = 0;
        if (goNext(cfg, '无下一节按钮')) {
          setPhase('reading', '正在加载下一节…');
        } else if (isCourseDone(cfg)) {
          setPhase('done', '本课程已完成');
          logger.info('课程已全部完成，不再切换');
        } else {
          setPhase('finished', '本章已读完，未找到下一节入口');
          logger.warn('未找到“下一节”入口，请手动切换');
        }
      } else if (docTrack.done) {
        setPhase('finished', `图文已读完（${formatPercent(info.ratio)}%）`);
      }
    } else {
      const step = Math.max(1, pxPerSec * Math.max(0.2, elapsed));
      attempt(() => reader.scrollBy(info.target, step), false);
      session.readSec += elapsed;
      setPhase('reading', `图文阅读中 · ${pxPerSec} px/s`);
    }

    return emit();
  }

  function runMaterialTick(cfg) {
    state.document = null;

    // 只打开「预览/查看」入口，不点下载：阅读即可，下载与进度无关
    if (cfg.autoPreview && !materialPreviewOpened) {
      const preview = materials.find((item) => item.preview && !clickedMaterials.has(item.key));
      if (preview) {
        materialPreviewOpened = true;
        clickedMaterials.add(preview.key);
        const opened = attempt(() => clickElement(preview.el), false);
        logger.info(`${opened ? '已打开资料预览' : '尝试打开资料预览'}：${preview.label}`);
      }
    }

    const elapsed = materialLastAt ? Math.max(0, (now() - materialLastAt) / 1000) : 0;
    materialLastAt = now();
    if (!materialPageDone) materialReadSec += elapsed;

    const goal = cfg.materialReadSec;
    state.materials = {
      count: materials.length,
      downloaded: clickedMaterials.size,
      readSec: Math.round(materialReadSec),
      goal,
    };

    if (materialReadSec < goal) {
      setPhase('reading', `资料阅读中 · ${Math.round(materialReadSec)}/${goal}s`);
      return emit();
    }

    if (!materialPageDone) {
      materialPageDone = true;
      session.segments += 1;
      logger.info(`资料页已停留 ${goal}s，计为已读：${materials.length} 份`);
      if (cfg.autoNext) materialNextAt = now() + cfg.nextDelayMs;
    }

    if (cfg.autoNext && materialNextAt && now() >= materialNextAt) {
      materialNextAt = 0;
      if (goNext(cfg, '无下一节按钮')) {
        setPhase('reading', '正在加载下一节…');
      } else if (isCourseDone(cfg)) {
        setPhase('done', '本课程已完成');
        logger.info('课程已全部完成，不再切换');
      } else {
        setPhase('finished', '资料已读完，未找到下一节入口');
      }
      return emit();
    }

    setPhase('finished', `资料已读完（停留 ${goal}s）`);
    return emit();
  }

  /** 调试：列出候选目录容器，帮助定位“为什么没识别到目录” */
  function inspectOutline() {
    const profile = adapter && adapter.profile ? adapter.profile : {};
    const data = attempt(() => outline.inspect(profile), []) || [];
    for (const item of data) {
      logger.info(`候选目录 class="${item.className}"：${item.itemCount} 项 / ${item.stateMarkers} 个完成标记`);
    }
    if (!data.length) logger.warn('页面没有找到任何候选课程目录容器');
    return data;
  }

  function jumpToNext() {
    const opened = jumpToNextUnfinished(config.get(), '手动');
    if (!opened) logger.warn('未找到可跳转的未完成小节：目录可能没有完成标记');
    return emit();
  }

  function downloadMaterials() {
    const pending = materials.filter((item) => !clickedMaterials.has(item.key));
    pending.forEach((item, index) => {
      env.setTimeout(() => {
        clickedMaterials.add(item.key);
        attempt(() => clickElement(item.el), false);
        state.materials = { count: materials.length, downloaded: clickedMaterials.size };
      }, index * 400);
    });

    if (pending.length > 0) {
      logger.info(`开始下载 ${pending.length} 份课件资料`);
      return { ok: true, queued: pending.length };
    }
    logger.warn('本页未找到可下载的资料');
    return { ok: false, queued: 0 };
  }

  /** 完整结构探针：把可用于精确适配的信息一次性输出成 JSON */
  function probe() {
    const snapshot = getState();
    const profile = adapter && adapter.profile ? adapter.profile : {};
    const containers = attempt(() => outline.inspect(profile), []) || [];
    const nextCandidates = adapter ? attempt(() => adapter.inspectNext(), []) || [] : [];

    const data = {
      url: String(env.location.href || ''),
      title: String(env.document.title || ''),
      platform: snapshot.platform,
      content: snapshot.content,
      phase: snapshot.phase,
      speed: snapshot.target,
      containers: containers.map((item) => ({
        source: item.source,
        className: item.className,
        itemCount: item.itemCount,
        stateMarkers: item.stateMarkers,
        detail: item.detail,
      })),
      nextCandidates,
      // 资料候选明细：用来诊断“列表页为什么被当成资料页”
      materials: materials.slice(0, 10).map((item) => ({
        label: item.label,
        preview: !!item.preview,
        href: attempt(() => String((item.el.getAttribute && item.el.getAttribute('href')) || '').slice(0, 120), ''),
        className: attempt(() => String(item.el.className || '').slice(0, 80), ''),
      })),
    };

    logger.info('结构探针输出如下，可复制整段 JSON 反馈');
    logger.info(JSON.stringify(data));
    return data;
  }

  function schedule() {
    if (!running) return;
    const delay = Math.max(300, config.get().tickMs);
    timer = env.setTimeout(() => {
      timer = null;
      if (!running) return;
      tick();
      schedule();
    }, delay);
  }

  function start() {
    if (running) return getState();
    running = true;
    if (!session.startedAt) session.startedAt = now();
    tick();
    schedule();
    return getState();
  }

  function stop() {
    running = false;
    if (timer !== null) {
      env.clearTimeout(timer);
      timer = null;
    }
    return getState();
  }

  function setEnabled(value) {
    config.set({ enabled: !!value });
    return tick();
  }

  function toggle() {
    return setEnabled(!config.get().enabled);
  }

  function setSpeed(value) {
    const numeric = Number(value);
    if (!isFiniteNumber(numeric)) return getState();
    config.set({ speed: numeric });
    return tick();
  }

  function skip() {
    if (!adapter) return getState();

    if (goNext(config.get(), '手动下一节')) {
      logger.info('手动切换到下一节，若页面无变化会自动换目录入口重试');
      return emit();
    }

    const candidates = attempt(() => adapter.inspectNext(), []) || [];
    logger.warn('未找到“下一节”入口，页面上的候选按钮：');
    for (const item of candidates.slice(0, 5)) {
      logger.info(`· ${item.text}（${item.className || '无 class'}）`);
    }
    return emit();
  }

  /**
   * 让用户点一次真实的“下一节”按钮，把选择器记下来。
   * 自动识别失败的站点用这一招，一次配置永久生效。
   */
  function pickNext() {
    const doc = env.document;
    if (!doc || typeof doc.addEventListener !== 'function') {
      return { ok: false, error: '当前环境不支持拾取' };
    }
    if (pickingNext) return { ok: false, error: '已经在等待点击' };

    pickingNext = true;

    const handler = (event) => {
      const target = event.target;
      if (target && typeof target.closest === 'function' && target.closest('#coursepilot-host')) return;

      event.preventDefault();
      event.stopPropagation();

      const selector = attempt(() => describeSelector(target), '');
      pickingNext = false;
      doc.removeEventListener('click', handler, true);

      if (!selector) {
        logger.warn('没能识别这个元素，换一个更靠中间的按钮再试一次');
        return;
      }

      const host = String((env.location && env.location.host) || '');
      config.set({ nextSelector: host ? `${host}|${selector}` : selector });
      logger.info(`已记住“下一节”按钮（${host}）：${selector}，本站之后优先点它`);
      setPhase('running', `已记住下一节按钮：${selector}`);
      emit();
    };

    doc.addEventListener('click', handler, true);
    logger.info('请点击一次页面上真正的“下一节 / 下一课”按钮');
    setPhase('running', '请点击一次“下一节”按钮（用于记住它）');
    emit();
    return { ok: true };
  }

  /** 调试：“下一节”点不动时，列出页面上的候选按钮 */
  function inspectNext() {
    const data = adapter ? attempt(() => adapter.inspectNext(), []) || [] : [];
    if (!data.length) logger.warn('页面上没有找到像“下一节”的按钮');
    for (const item of data) logger.info(`候选按钮：${item.text}（${item.className || '无 class'}）`);
    return data;
  }

  /** 一键诊断：把目录候选、下一节候选、当前状态全部写进日志并返回 */
  function report() {
    const profile = adapter && adapter.profile ? adapter.profile : {};
    const snapshot = getState();
    const data = {
      version: VERSION,
      url: String(env.location.href || ''),
      title: String(env.document.title || ''),
      platform: snapshot.platform,
      content: snapshot.content,
      phase: snapshot.phase,
      outline: attempt(() => outline.inspect(profile), []) || [],
      nextCandidates: adapter ? attempt(() => adapter.inspectNext(), []) || [] : [],
      // 资料候选明细：诊断“列表页为什么被当成资料页”
      materials: materials.slice(0, 10).map((item) => ({
        label: item.label,
        preview: !!item.preview,
        href: attempt(() => String((item.el.getAttribute && item.el.getAttribute('href')) || '').slice(0, 120), ''),
        className: attempt(() => String(item.el.className || '').slice(0, 80), ''),
      })),
    };

    logger.info(`诊断：${data.platform.name} / ${data.content} / ${data.phase} / 目录候选 ${data.outline.length} 个 / 按钮候选 ${data.nextCandidates.length} 个`);
    for (const item of data.outline) {
      logger.info(`目录候选[${item.source}] class="${item.className || '无'}"：${item.itemCount} 项 / ${item.stateMarkers} 个标记`);
    }
    for (const item of data.nextCandidates.slice(0, 6)) {
      logger.info(`下一节候选：${item.text}（${item.className || '无 class'}）`);
    }
    return data;
  }

  function dispose() {
    stop();
    if (adapter && video) attempt(() => adapter.restoreRate(video), null);
    subscribers.clear();
  }

  return {
    start,
    stop,
    dispose,
    tick,
    toggle,
    setEnabled,
    setSpeed,
    skip,
    jumpToNext,
    pickNext,
    inspectOutline,
    inspectNext,
    report,
    probe,
    downloadMaterials,
    getState,
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
  };
}

// ---------- src/ui/styles.js ----------
const PANEL_CSS = `
*, *::before, *::after { box-sizing: border-box; }

.cp-panel {
  position: fixed;
  right: 18px;
  bottom: 18px;
  width: 328px;
  font: 13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: #e8ecf4;
  background: linear-gradient(168deg, rgba(22,27,38,.97), rgba(9,12,18,.98));
  border: 1px solid rgba(255,255,255,.09);
  border-radius: 16px;
  box-shadow: 0 26px 64px -14px rgba(0,0,0,.8), inset 0 1px 0 rgba(255,255,255,.05);
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
  overflow: hidden;
  user-select: none;
  --accent: #5eead4;
  --accent-soft: rgba(94,234,212,.14);
  --muted: #8b94a8;
  --surface: rgba(255,255,255,.045);
  --surface-strong: rgba(255,255,255,.08);
}

.cp-panel[data-phase="blocked"] { --accent: #fbbf24; --accent-soft: rgba(251,191,36,.15); }
.cp-panel[data-phase="error"] { --accent: #fb7185; --accent-soft: rgba(251,113,133,.15); }
.cp-panel[data-phase="finished"], .cp-panel[data-phase="done"] { --accent: #a78bfa; --accent-soft: rgba(167,139,250,.16); }
.cp-panel[data-phase="disabled"] { --accent: #64748b; --accent-soft: rgba(100,116,139,.18); }

.cp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 11px 12px 9px;
  cursor: grab;
  border-bottom: 1px solid rgba(255,255,255,.055);
}
.cp-head:active { cursor: grabbing; }

.cp-brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
.cp-pulse {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 4px var(--accent-soft);
  flex: 0 0 auto;
}
.cp-panel[data-phase="running"] .cp-pulse { animation: cp-pulse 2.2s ease-in-out infinite; }
.cp-panel[data-phase="blocked"] .cp-pulse { animation: cp-blink 1s steps(2, start) infinite; }
@keyframes cp-pulse {
  0%, 100% { box-shadow: 0 0 0 3px var(--accent-soft); }
  50% { box-shadow: 0 0 0 7px rgba(94,234,212,.02); }
}
@keyframes cp-blink { 50% { opacity: .25; } }

.cp-title { font-weight: 650; letter-spacing: .2px; font-size: 13.5px; }
.cp-head-right { display: flex; align-items: center; gap: 6px; }

.cp-badge {
  max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding: 2px 8px; border-radius: 999px;
  font-size: 11px; color: var(--accent);
  background: var(--accent-soft);
  border: 1px solid rgba(255,255,255,.06);
}

.cp-icon {
  width: 22px; height: 22px; line-height: 1;
  display: grid; place-items: center;
  border-radius: 7px; border: 1px solid transparent;
  background: transparent; color: var(--muted);
  font-size: 14px; cursor: pointer;
  transition: background .15s ease, color .15s ease;
}
.cp-icon:hover { background: var(--surface-strong); color: #e8ecf4; }

.cp-statusline {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px;
  font-size: 12px; color: var(--muted);
  background: rgba(0,0,0,.22);
}
.cp-statusline .cp-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--accent); flex: 0 0 auto;
}
.cp-status { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #c7cede; }
.cp-kind {
  flex: 0 0 auto; padding: 1px 6px; border-radius: 5px;
  font-size: 10.5px; font-weight: 650; line-height: 1.6;
  color: #cfd8ea; background: rgba(255, 255, 255, .1);
}
.cp-kind[hidden] { display: none; }
.cp-pct { font-variant-numeric: tabular-nums; color: var(--accent); font-weight: 600; }

.cp-body { padding: 12px; max-height: 64vh; overflow-y: auto; }
.cp-tab[hidden] { display: none; }

.cp-progress { margin-bottom: 12px; }
.cp-track {
  height: 6px; border-radius: 999px; overflow: hidden;
  background: rgba(255,255,255,.07);
}
.cp-fill {
  height: 100%; width: 0%;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--accent), #a78bfa);
  transition: width .45s cubic-bezier(.22,1,.36,1);
}
.cp-progress-meta {
  display: flex; justify-content: space-between; gap: 8px;
  margin-top: 6px; font-size: 11.5px; color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.cp-progress-meta span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 55%; text-align: right; }

.cp-row { display: flex; gap: 8px; margin-bottom: 12px; }

.cp-btn {
  flex: 1 1 0;
  padding: 8px 10px;
  border-radius: 9px;
  border: 1px solid rgba(255,255,255,.09);
  background: var(--surface);
  color: #dbe1ee;
  font-size: 12.5px; font-weight: 550;
  cursor: pointer;
  transition: transform .12s ease, background .15s ease, border-color .15s ease;
}
.cp-btn:hover { background: var(--surface-strong); border-color: rgba(255,255,255,.16); }
.cp-btn:active { transform: scale(.97); }
.cp-btn.primary {
  background: linear-gradient(135deg, rgba(94,234,212,.22), rgba(167,139,250,.2));
  border-color: rgba(94,234,212,.35);
  color: #d7fff7;
}
.cp-btn.ghost { flex: 0 0 auto; width: 100%; margin-top: 10px; background: transparent; color: var(--muted); }

.cp-speed { padding: 10px; border-radius: 11px; background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.05); }
.cp-label-row { display: flex; justify-content: space-between; align-items: baseline; font-size: 12px; color: var(--muted); }
.cp-label-row b { color: var(--accent); font-size: 15px; font-variant-numeric: tabular-nums; }
.cp-rate-wrap { display: inline-flex; align-items: center; gap: 6px; }
.cp-lock {
  font-style: normal; font-size: 10px; font-weight: 650; line-height: 1.6;
  padding: 0 7px; border-radius: 999px;
  color: var(--accent); background: var(--accent-soft);
  border: 1px solid rgba(94, 234, 212, .28);
}
.cp-lock[hidden] { display: none; }

.cp-range {
  -webkit-appearance: none; appearance: none;
  width: 100%; height: 18px; margin: 4px 0 2px;
  background: transparent; cursor: pointer;
}
.cp-range::-webkit-slider-runnable-track {
  height: 4px; border-radius: 999px;
  background: linear-gradient(90deg, rgba(94,234,212,.65), rgba(167,139,250,.5));
}
.cp-range::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 13px; height: 13px; margin-top: -4.5px;
  border-radius: 50%; background: #eef2ff;
  border: 2px solid #0b0e14;
  box-shadow: 0 0 0 3px rgba(94,234,212,.18);
}
.cp-range::-moz-range-track { height: 4px; border-radius: 999px; background: rgba(255,255,255,.16); }
.cp-range::-moz-range-thumb { width: 13px; height: 13px; border: 2px solid #0b0e14; border-radius: 50%; background: #eef2ff; }

.cp-presets { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
.cp-presets button {
  padding: 3px 8px; border-radius: 7px;
  border: 1px solid rgba(255,255,255,.08);
  background: transparent; color: var(--muted);
  font-size: 11.5px; cursor: pointer;
  transition: all .14s ease;
}
.cp-presets button:hover { color: #e8ecf4; border-color: rgba(255,255,255,.2); }
.cp-presets button.on { color: #06231f; background: var(--accent); border-color: var(--accent); font-weight: 650; }

.cp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; }
.cp-cell {
  padding: 8px 10px; border-radius: 10px;
  background: rgba(255,255,255,.03);
  border: 1px solid rgba(255,255,255,.05);
}
.cp-cell span { display: block; font-size: 11px; color: var(--muted); }
.cp-cell b { display: block; margin-top: 2px; font-size: 14px; font-variant-numeric: tabular-nums; }

.cp-materials {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin-top: 10px; padding: 7px 10px;
  border-radius: 10px;
  border: 1px dashed rgba(255, 255, 255, .14);
  background: rgba(255, 255, 255, .03);
  font-size: 12px; color: var(--muted);
}
.cp-materials > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp-materials b { color: var(--accent); font-variant-numeric: tabular-nums; }
.cp-materials[hidden] { display: none; }
.cp-btn.sm { flex: 0 0 auto; width: auto; padding: 4px 10px; font-size: 11.5px; }

.cp-switch {
  display: flex; align-items: center; justify-content: space-between;
  padding: 9px 2px; cursor: pointer;
  border-bottom: 1px solid rgba(255,255,255,.045);
}
.cp-switch span { font-size: 12.5px; color: #cdd4e2; }
.cp-switch input { position: absolute; opacity: 0; pointer-events: none; }
.cp-switch i {
  position: relative; width: 34px; height: 19px; border-radius: 999px;
  background: rgba(255,255,255,.12);
  transition: background .18s ease;
  flex: 0 0 auto;
}
.cp-switch i::after {
  content: ""; position: absolute; top: 2.5px; left: 2.5px;
  width: 14px; height: 14px; border-radius: 50%;
  background: #cfd6e4; transition: transform .18s cubic-bezier(.2,1,.3,1), background .18s ease;
}
.cp-switch input:checked + i { background: var(--accent-soft); }
.cp-switch input:checked + i::after { transform: translateX(15px); background: var(--accent); }

.cp-field { padding: 10px 2px 2px; }
.cp-field > span { display: block; font-size: 12px; color: var(--muted); }
.cp-field b { color: var(--accent); font-variant-numeric: tabular-nums; }

.cp-logs {
  list-style: none; margin: 0; padding: 0;
  height: 208px; overflow-y: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px; line-height: 1.7;
}
.cp-logs li { color: #9aa4b8; padding: 1px 0; word-break: break-all; }
.cp-logs li.cp-log-warn { color: #fbbf24; }
.cp-logs li.cp-log-error { color: #fb7185; }
.cp-logs li.cp-log-info { color: #9aa4b8; }

.cp-tabs {
  display: flex; gap: 4px; padding: 6px;
  background: rgba(0,0,0,.26);
  border-top: 1px solid rgba(255,255,255,.05);
}
.cp-tabs button {
  flex: 1 1 0; padding: 5px 0;
  border: 0; border-radius: 8px; background: transparent;
  color: var(--muted); font-size: 12px; cursor: pointer;
  transition: background .15s ease, color .15s ease;
}
.cp-tabs button:hover { color: #e8ecf4; }
.cp-tabs button.on { background: var(--surface-strong); color: #e8ecf4; }

.cp-panel[data-folded="true"] { width: 224px; }
.cp-panel[data-folded="true"] .cp-body,
.cp-panel[data-folded="true"] .cp-tabs { display: none; }
.cp-panel[data-folded="true"] .cp-statusline { padding-bottom: 9px; }

@media (prefers-reduced-motion: reduce) {
  .cp-pulse, .cp-fill { animation: none !important; transition: none !important; }
}
`;

// ---------- src/ui/panel.js ----------
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
 */function createPanel({ engine, config, logger, env }) {
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

// ---------- src/api.js ----------
/**
 * 对外 API：浏览器控制台 / 其他脚本可通过 window.coursepilot 调用。
 */function createApi({ engine, panel, config, logger, win }) {
  const api = {
    name: APP_NAME,
    version: VERSION,
    engine,
    panel,
    config,
    log: logger,

    state: () => engine.getState(),
    setSpeed: (value) => engine.setSpeed(value),
    toggle: () => engine.toggle(),
    enable: () => engine.setEnabled(true),
    disable: () => engine.setEnabled(false),
    next: () => engine.skip(),
    jump: () => engine.jumpToNext(),
    pickNext: () => engine.pickNext(),
    inspectOutline: () => engine.inspectOutline(),
    inspectNext: () => engine.inspectNext(),
    report: () => engine.report(),
    probe: () => engine.probe(),

    showPanel() {
      panel.show();
      config.set({ panel: { hidden: false } });
    },
    hidePanel() {
      panel.hide();
      config.set({ panel: { hidden: true } });
    },

    destroy() {
      engine.dispose();
      panel.destroy();
      if (win && win.__coursepilot === api) delete win.__coursepilot;
      if (win && win.coursepilot === api) delete win.coursepilot;
    },
  };

  return api;
}

// ---------- src/main.js ----------
function createStorage(win) {
  if (typeof GM_getValue === 'function' && typeof GM_setValue === 'function') {
    return {
      read(key) {
        try {
          return GM_getValue(key, null);
        } catch {
          return null;
        }
      },
      write(key, value) {
        try {
          GM_setValue(key, value);
        } catch {
          /* 存储被禁用时静默降级 */
        }
      },
    };
  }

  try {
    const ls = win.localStorage;
    const probe = '__coursepilot_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return {
      read(key) {
        try {
          const raw = ls.getItem(key);
          return raw ? JSON.parse(raw) : null;
        } catch {
          return null;
        }
      },
      write(key, value) {
        try {
          ls.setItem(key, JSON.stringify(value));
        } catch {
          /* ignore */
        }
      },
    };
  } catch {
    return { read: () => null, write: () => {} };
  }
}

function registerMenu(api) {
  if (typeof GM_registerMenuCommand !== 'function') return;
  try {
    GM_registerMenuCommand('显示 CoursePilot 面板', () => api.showPanel());
    GM_registerMenuCommand('暂停 / 继续托管', () => api.toggle());
  } catch {
    /* 菜单注册失败不影响主流程 */
  }
}

function isTopFrame(win) {
  try {
    return win.top === win.self;
  } catch {
    return true;
  }
}

/**
 * 入口：幂等启动，重复注入直接复用已有实例。
 * options.force 用于本地 Demo / 手动注入到未登记域名。
 */function bootstrap(options = {}) {
  const win = options.window || (typeof window !== 'undefined' ? window : null);
  if (!win || !win.document) return null;

  const existing = win.__coursepilot;
  if (existing && existing.version === VERSION) return existing;

  // 供 Demo / 手动注入使用：未登记域名可显式 force 启动
  win.CoursePilotBootstrap = bootstrap;

  if (!options.force) {
    const protocol = String(win.location.protocol || '');
    if (protocol !== 'http:' && protocol !== 'https:') return null;
    if (win.location.username || win.location.password) return null;
  }

  const doc = win.document;
  const logger = createLogger({ capacity: 200, dedupeMs: 1200 });
  const storage = createStorage(win);
  const config = createConfigStore({
    read: () => storage.read(STORAGE_KEY),
    write: (value) => storage.write(STORAGE_KEY, value),
  });

  const rateManager = createRateManager();
  const env = {
    document: doc,
    window: win,
    location: win.location,
    now: () => Date.now(),
    setTimeout: (fn, ms) => win.setTimeout(fn, ms),
    clearTimeout: (id) => win.clearTimeout(id),
    rateManager,
    adapterFor: (href) => createAdapter(href, { document: doc, window: win, rateManager }),
  };

  const engine = createEngine({ config, logger, env });

  // 子框架只跑引擎，不重复挂面板，避免同一页面出现多个悬浮窗
  if (!isTopFrame(win)) {
    engine.start();
    const frameApi = {
      name: APP_NAME,
      version: VERSION,
      engine,
      config,
      log: logger,
      state: () => engine.getState(),
      setSpeed: (value) => engine.setSpeed(value),
      destroy: () => engine.dispose(),
    };
    win.__coursepilot = frameApi;
    return frameApi;
  }

  const panel = createPanel({ engine, config, logger, env });
  const api = createApi({ engine, panel, config, logger, win });
  win.__coursepilot = api;
  win.coursepilot = api;

  // 面板不随页面加载自动弹出：先隐藏，等引擎识别到课程内容（视频 / 图文 / 资料）
  // 再自动显示；门户、课程列表、登录等页面保持安静，需要时用油猴菜单或扩展按钮打开
  panel.hide();

  let autoShown = false;
  engine.subscribe((state) => {
    if (autoShown) return;
    const hasContent = state.content === 'video' || state.content === 'document' || state.content === 'material';
    if (!hasContent) return;
    autoShown = true;
    if (config.get().autoShow && !config.get().panel.hidden) panel.show();
  });

  engine.start();
  logger.info(`${APP_NAME} v${VERSION} 已启动`);
  registerMenu(api);

  return api;
}

  bootstrap();
})();
