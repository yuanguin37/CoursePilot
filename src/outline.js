/**
 * 课程目录扫描：找出「哪一章哪一节」，供引擎跳转与顺序推进。
 * 只读页面 DOM 并点击目录项，不请求任何平台接口。
 *
 * 三条查找路径：平台声明选择器 → 目录类名 → 纯结构（标题像章节的列表）。
 */
import { clickElement } from './dom.js';

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
}

export function createOutline(env) {
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
