export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function clampNumber(value, min, max, fallback) {
  return isFiniteNumber(value) ? clamp(value, min, max) : fallback;
}

export function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 秒 → 1:02:03 / 02:03，非法值统一显示 --:-- */
export function formatClock(seconds) {
  if (!isFiniteNumber(seconds) || seconds < 0) return '--:--';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

/** 0~1 的比例 → "63.2"（不带百分号，便于拼接文案） */
export function formatPercent(ratio) {
  if (!isFiniteNumber(ratio)) return '0.0';
  return (clamp(ratio, 0, 1) * 100).toFixed(1);
}

/** 倍速 → 4× / 1.5× / 0.75× */
export function formatRate(rate) {
  if (!isFiniteNumber(rate)) return '—';
  return `${rate.toFixed(2).replace(/\.?0+$/, '')}×`;
}

/** 只合并一层嵌套对象，其余按值覆盖；用于配置补丁 */
export function mergeConfig(base, patch) {
  const output = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (isPlainObject(value) && isPlainObject(base[key])) output[key] = { ...base[key], ...value };
    else output[key] = value;
  }
  return output;
}
