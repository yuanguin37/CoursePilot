import { formatPercent, formatRate, isFiniteNumber } from './util.js';
import { readMedia, RATE_AUDIBLE_MAX } from './media.js';
import { createReader, findMaterials, findPdfViewer, READ_BASE_PX } from './reader.js';
import { createOutline } from './outline.js';
import { clickElement, describeSelector } from './dom.js';

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
 */
export function createEngine({ config, logger, env }) {
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
      // 引擎点击导致页面变化：若落在列表/首页，判定为误点，自动跳回点击前的页面。
      // “只有用户自己才能离开课程”的硬边界。
      const landedBad = attempt(() => {
        const url = new URL(currentHref);
        return attempt(() => adapter.isListPage(), false)
          || /^\/(index\/?)?$/i.test(url.pathname)
          || /(\/ci\/web\/index|\/web\/list|\/web\/myCourses|\/web\/studentLog|\/home\b)/i.test(url.pathname);
      }, false);
      const backHref = pendingJump.href;
      const fresh = now() - pendingJump.at < 8000;
      pendingJump = null;
      if (landedBad && fresh && backHref) {
        const win = env.window;
        if (win && win.location && typeof win.location.assign === 'function') {
          logger.warn('检测到自动操作把页面带回列表/首页，正在回退…');
          try {
            win.location.assign(backHref);
            setPhase('searching', '已自动回退，请稍候…');
          } catch {
            /* 忽略 */
          }
        }
      }
      return;
    }
    if (now() - pendingJump.at < 2500) return;
    // 展开模块这类“无导航预期”的点击只做回退哨兵，不做直达补试
    if (pendingJump.soft) {
      pendingJump = null;
      return;
    }

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
        pendingJump = {
          item: { title: '展开模块', href: '' },
          href: String(env.location.href || ''),
          title: String(env.document.title || ''),
          at: now(),
          soft: true,
        };
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
