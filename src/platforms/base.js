import { collectVideos, findFirstVisible, findByText, findGenericNext, clickElement, queryAllDeep } from '../dom.js';
import { createRateManager, isVisibleMedia, readMedia } from '../media.js';
import { isFiniteNumber } from '../util.js';

/** 通用“下一节”文案，按平台差异可被 profile.next 精确选择器覆盖 */
export const NEXT_LABELS = ['下一节', '下一课', '下一讲', '下一集', '下一章', '下一课时', '下一个', '继续学习'];

/**
 * 基础适配器：所有平台共享的行为都在这里。
 * 平台差异由 profile（选择器/文案）与 quirk（特殊播放器）两层补齐。
 */
export function createBaseAdapter(profile, env) {
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
