import { clickElement } from '../dom.js';
import { readRate } from '../media.js';

const ACTIVE_CLASS = 'xt_video_player_common_active';
const state = new WeakMap();

/**
 * 雨课堂 / 学堂在线 的 Vue 播放器：倍速按钮是一个 <li data-speed>，
 * 播放器内部同时保存 options.speed.value 与 options.isDrag，两者不同步就会被重置。
 */
export function findXtPlayer(doc) {
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

export const xtplayerQuirk = {
  findVideo(ctx) {
    const host = findXtPlayer(ctx.env.document);
    return host ? host.video : ctx.base.findVideo();
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
