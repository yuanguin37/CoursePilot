/**
 * CoursePilot 扩展后台：工具栏图标点击后的入口。
 * - 页面已运行：直接显示面板
 * - 页面未运行：注入脚本并强制启动（让未登记域名也能用）
 */
const SCRIPT_FILE = 'coursepilot.js';

async function callInPage(tabId, func) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func,
  });
  return result ? result.result : undefined;
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || typeof tab.id !== 'number') return;

  try {
    const running = await callInPage(tab.id, () => Boolean(window.__coursepilot && window.__coursepilot.showPanel));

    if (running) {
      await callInPage(tab.id, () => window.__coursepilot.showPanel());
      return;
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      files: [SCRIPT_FILE],
    });

    // 未登记域名不会自动启动，这里显式 force 一次
    await callInPage(tab.id, () => {
      if (typeof window.CoursePilotBootstrap === 'function') {
        window.CoursePilotBootstrap({ force: true });
      }
      if (window.__coursepilot && window.__coursepilot.showPanel) {
        window.__coursepilot.showPanel();
      }
    });
  } catch (error) {
    // chrome:// 页面、扩展商店等受限页面会走到这里，静默忽略
    console.warn('CoursePilot:', error && error.message);
  }
});
