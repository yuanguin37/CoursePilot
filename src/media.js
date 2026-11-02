import { isFiniteNumber } from './util.js';

export const RATE_MIN = 0.25;
export const RATE_MAX = 16;
/** 主流浏览器在 4× 以上会自动静音，用于给用户提示 */
export const RATE_AUDIBLE_MAX = 4;

function rateDescriptor() {
  try {
    const proto = globalThis.HTMLMediaElement && globalThis.HTMLMediaElement.prototype;
    return proto ? Object.getOwnPropertyDescriptor(proto, 'playbackRate') || null : null;
  } catch {
    return null;
  }
}

/** 读取当前生效倍速；若已安装锁定，返回锁定目标值 */
export function readRate(video) {
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
 */
export function isVisibleMedia(video) {
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
}

export function readMedia(video) {
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
 */
export function createRateManager() {
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
