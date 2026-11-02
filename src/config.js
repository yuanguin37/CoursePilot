import { clampNumber, isFiniteNumber, isPlainObject, mergeConfig } from './util.js';

export const TABS = ['overview', 'settings', 'logs'];

export const DEFAULT_CONFIG = Object.freeze({
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
  /** 首次发现视频时自动弹出面板 */
  autoShow: true,
  /** 点击下一节前的缓冲时间（毫秒），给平台上报进度留出窗口 */
  nextDelayMs: 3000,
  /** 进度达到该比例即视为本节完成 */
  completeThreshold: 0.98,
  /** 引擎轮询间隔（毫秒） */
  tickMs: 1000,
  panel: Object.freeze({ folded: false, hidden: false, tab: 'overview', x: null, y: null }),
});

export function sanitizeConfig(raw) {
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
 */
export function createConfigStore({ read, write } = {}) {
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
