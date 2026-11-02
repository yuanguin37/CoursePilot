/**
 * 图文 / 文档阅读与课件资料：
 * - createReader 负责找到可滚动的阅读容器并按节奏推进
 * - findMaterials 负责识别页面上的课件、附件下载入口
 * 只驱动真实 UI（滚动、点击），不调用任何平台接口。
 */
const TEXT_MIN = 400;
const SCROLL_MIN = 200;
const CACHE_MS = 800;

/** 1× 时的滚动速度（像素/秒），倍速在此基础上线性放大 */
export const READ_BASE_PX = 16;

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
}

export function createReader(env) {
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

/** 浏览器内置 PDF 阅读器（embed / cross-origin iframe）无法被脚本滚动 */
export function findPdfViewer(doc) {
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
 */
export function findMaterials(doc, profile = {}) {
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
