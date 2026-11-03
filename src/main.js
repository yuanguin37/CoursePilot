import { APP_NAME, VERSION, STORAGE_KEY } from './version.js';
import { createLogger } from './log.js';
import { createConfigStore } from './config.js';
import { createAdapter } from './platforms/index.js';
import { createEngine } from './engine.js';
import { createPanel } from './ui/panel.js';
import { createApi } from './api.js';
import { createRateManager } from './media.js';

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
 */
export function bootstrap(options = {}) {
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
