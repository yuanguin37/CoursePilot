import { createBaseAdapter } from './base.js';
import { xtplayerQuirk } from './xtplayer.js';
import { matchProfile } from './profiles.js';

export const QUIRK_TABLE = {
  native: {},
  xtplayer: xtplayerQuirk,
};

/**
 * 组合 profile + quirk 生成适配器：
 * quirk 只覆盖它真正需要的几个方法，其余行为回落到 base。
 */
export function createAdapter(href, env) {
  const profile = matchProfile(href);
  const quirk = QUIRK_TABLE[profile.quirk] || QUIRK_TABLE.native;
  const base = createBaseAdapter(profile, env);
  const adapter = { ...base };

  for (const key of Object.keys(quirk)) {
    adapter[key] = (...args) => quirk[key]({ base, env, profile }, ...args);
  }

  /** 平台声明的门户/列表页：这类 URL 不参与内容托管，引擎只做目录跳转 */
  adapter.isListPage = () => {
    try {
      const path = String(env.location.pathname || '');
      return (profile.listPages || []).some((pattern) => !!pattern && path.includes(pattern));
    } catch {
      return false;
    }
  };

  return adapter;
}
