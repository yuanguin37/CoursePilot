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
}

export function collectVideos(root) {
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
}

export function queryAllDeep(root, selector) {
  if (!root || !selector) return [];
  const hit = cache.get(selector);
  const now = Date.now();
  if (hit && hit.root === root && now - hit.at < CACHE_TTL) return hit.value;

  const value = scanSelector(root, selector);
  if (cache.size > 60) cache.clear();
  cache.set(selector, { root, at: now, value });
  return value;
}

export function isVisible(el) {
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
}

export function findFirstVisible(root, selectors) {
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
}

export function findByText(root, labels) {
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
 */
export function findGenericNext(root) {
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
}

export function describeSelector(el) {
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

/** 模拟一次完整的点击序列，兼容 Vue / React 的合成事件 */
export function clickElement(el) {
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
