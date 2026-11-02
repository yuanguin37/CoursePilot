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
      const href = rawHref && !/^javascript:/i.test(rawHref) && !rawHref.startsWith('#') ? rawHref : '';
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
      logger.info(`平台适配：${adapter.name}`);
    }

    // 即使暂停托管也完成平台识别，避免面板一直显示“通用网页”
    if (!cfg.enabled) {
      setPhase('disabled', '托管已关闭');
      state.video = null;
      return emit();
    }

    checkPendingJump();

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
      const clicked = attempt(() => adapter.next({ selector: cfg.nextSelector }), null);
      if (clicked) {
        session.switches += 1;
        logger.info('已切换到下一节');
        resetTrack(null);
        setPhase('searching', '正在加载下一节…');
      } else if (cfg.autoJump && jumpToNextUnfinished(cfg, '无下一节按钮')) {
        resetTrack(null);
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

  /** 内容自动识别：视频优先，其次图文，最后资料页 */
  function tickDocument(cfg) {
    state.mode = 'document';

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
        const result = attempt(() => adapter.next({ selector: cfg.nextSelector }), null);
        if (result) {
          session.switches += 1;
          setPhase('reading', '正在加载下一节…');
          logger.info('已切换到下一节');
        } else if (jumpToNextUnfinished(cfg, 'PDF 之后')) {
          /* 已跳转 */
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

    if (materials.length > 0) {
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

    setPhase('searching', cfg.documentMode ? '等待视频、图文或资料…' : '未发现视频（图文阅读已关闭）');
    return emit();
  }

  function autoDownloadTick() {
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
        const clicked = attempt(() => adapter.next({ selector: cfg.nextSelector }), null);
        if (clicked) {
          session.switches += 1;
          docTrack = { target: null, lastAt: now(), done: false, nextAt: 0 };
          setPhase('reading', '正在加载下一节…');
          logger.info('已切换到下一节');
        } else if (cfg.autoJump && jumpToNextUnfinished(cfg, '无下一节按钮')) {
          docTrack = { target: null, lastAt: now(), done: false, nextAt: 0 };
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
      const clicked = attempt(() => adapter.next({ selector: cfg.nextSelector }), null);
      if (clicked) {
        session.switches += 1;
        setPhase('reading', '正在加载下一节…');
        logger.info('已切换到下一节');
      } else if (cfg.autoJump && jumpToNextUnfinished(cfg, '无下一节按钮')) {
        /* 已跳转 */
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

    const result = attempt(() => adapter.next({ selector: config.get().nextSelector }), null);
    if (result) {
      session.switches += 1;
      resetTrack(null);
      docTrack = { target: null, lastAt: now(), done: false, nextAt: 0 };
      setPhase('searching', '正在加载下一节…');
      logger.info(`手动切换到下一节（${(result && result.strategy) || '按钮'}）`);
      return emit();
    }

    // 没有“下一节”按钮时，先按目录顺序取下一项
    const ordered = attempt(() => outline.nextInOrder(adapter.profile || {}), null);
    if (ordered && attempt(() => outline.open(ordered), false)) {
      session.switches += 1;
      resetTrack(null);
      docTrack = { target: null, lastAt: now(), done: false, nextAt: 0 };
      setPhase('searching', '正在加载下一节…');
      logger.info(`手动切换到下一节（目录顺序：${ordered.title} · 点击 ${ordered.clickTag || 'element'}）`);
      return emit();
    }

    // 再退回“第一个未完成小节”
    if (attempt(() => jumpToNextUnfinished(config.get(), '手动下一节'), false)) return emit();

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

      config.set({ nextSelector: selector });
      logger.info(`已记住“下一节”按钮：${selector}，之后优先点它`);
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
      url: String(env.location.href || ''),
      title: String(env.document.title || ''),
      platform: snapshot.platform,
      content: snapshot.content,
      phase: snapshot.phase,
      outline: attempt(() => outline.inspect(profile), []) || [],
      nextCandidates: adapter ? attempt(() => adapter.inspectNext(), []) || [] : [],
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
