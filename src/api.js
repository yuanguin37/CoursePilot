import { APP_NAME, VERSION } from './version.js';

/**
 * 对外 API：浏览器控制台 / 其他脚本可通过 window.coursepilot 调用。
 */
export function createApi({ engine, panel, config, logger, win }) {
  const api = {
    name: APP_NAME,
    version: VERSION,
    engine,
    panel,
    config,
    log: logger,

    state: () => engine.getState(),
    setSpeed: (value) => engine.setSpeed(value),
    toggle: () => engine.toggle(),
    enable: () => engine.setEnabled(true),
    disable: () => engine.setEnabled(false),
    next: () => engine.skip(),
    jump: () => engine.jumpToNext(),
    pickNext: () => engine.pickNext(),
    inspectOutline: () => engine.inspectOutline(),
    inspectNext: () => engine.inspectNext(),
    report: () => engine.report(),
    probe: () => engine.probe(),

    showPanel() {
      panel.show();
      config.set({ panel: { hidden: false } });
    },
    hidePanel() {
      panel.hide();
      config.set({ panel: { hidden: true } });
    },

    destroy() {
      engine.dispose();
      panel.destroy();
      if (win && win.__coursepilot === api) delete win.__coursepilot;
      if (win && win.coursepilot === api) delete win.coursepilot;
    },
  };

  return api;
}
