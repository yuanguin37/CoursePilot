/**
 * 环形日志：供面板展示、供 API 导出。
 * dedupeMs > 0 时，相同级别+文案在高频轮询下只保留一条。
 */
export function createLogger({ capacity = 200, dedupeMs = 0, now = () => Date.now() } = {}) {
  const items = [];
  const listeners = new Set();
  let lastKey = '';
  let lastAt = -Infinity;

  function push(level, message, detail) {
    const at = now();
    const key = `${level}:${message}`;
    if (dedupeMs > 0 && key === lastKey && at - lastAt < dedupeMs) return null;
    lastKey = key;
    lastAt = at;

    const entry = {
      at,
      time: new Date(at).toTimeString().slice(0, 8),
      level,
      message: String(message),
      detail: detail === undefined ? null : detail,
    };
    items.push(entry);
    if (items.length > capacity) items.splice(0, items.length - capacity);
    for (const listener of listeners) {
      try {
        listener(entry);
      } catch {
        /* 单个订阅者异常不应影响日志写入 */
      }
    }
    return entry;
  }

  return {
    push,
    debug: (message, detail) => push('debug', message, detail),
    info: (message, detail) => push('info', message, detail),
    warn: (message, detail) => push('warn', message, detail),
    error: (message, detail) => push('error', message, detail),
    entries: () => items.slice(),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clear() {
      items.length = 0;
      for (const listener of listeners) {
        try {
          listener(null);
        } catch {
          /* ignore */
        }
      }
    },
    text: () => items.map((item) => `[${item.time}] ${item.level.toUpperCase()} ${item.message}`).join('\n'),
  };
}
