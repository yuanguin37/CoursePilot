export const PANEL_CSS = `
*, *::before, *::after { box-sizing: border-box; }

.cp-panel {
  position: fixed;
  right: 18px;
  bottom: 18px;
  width: 328px;
  font: 13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: #e8ecf4;
  background: linear-gradient(168deg, rgba(22,27,38,.97), rgba(9,12,18,.98));
  border: 1px solid rgba(255,255,255,.09);
  border-radius: 16px;
  box-shadow: 0 26px 64px -14px rgba(0,0,0,.8), inset 0 1px 0 rgba(255,255,255,.05);
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
  overflow: hidden;
  user-select: none;
  --accent: #5eead4;
  --accent-soft: rgba(94,234,212,.14);
  --muted: #8b94a8;
  --surface: rgba(255,255,255,.045);
  --surface-strong: rgba(255,255,255,.08);
}

.cp-panel[data-phase="blocked"] { --accent: #fbbf24; --accent-soft: rgba(251,191,36,.15); }
.cp-panel[data-phase="error"] { --accent: #fb7185; --accent-soft: rgba(251,113,133,.15); }
.cp-panel[data-phase="finished"], .cp-panel[data-phase="done"] { --accent: #a78bfa; --accent-soft: rgba(167,139,250,.16); }
.cp-panel[data-phase="disabled"] { --accent: #64748b; --accent-soft: rgba(100,116,139,.18); }

.cp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 11px 12px 9px;
  cursor: grab;
  border-bottom: 1px solid rgba(255,255,255,.055);
}
.cp-head:active { cursor: grabbing; }

.cp-brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
.cp-pulse {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 4px var(--accent-soft);
  flex: 0 0 auto;
}
.cp-panel[data-phase="running"] .cp-pulse { animation: cp-pulse 2.2s ease-in-out infinite; }
.cp-panel[data-phase="blocked"] .cp-pulse { animation: cp-blink 1s steps(2, start) infinite; }
@keyframes cp-pulse {
  0%, 100% { box-shadow: 0 0 0 3px var(--accent-soft); }
  50% { box-shadow: 0 0 0 7px rgba(94,234,212,.02); }
}
@keyframes cp-blink { 50% { opacity: .25; } }

.cp-title { font-weight: 650; letter-spacing: .2px; font-size: 13.5px; }
.cp-head-right { display: flex; align-items: center; gap: 6px; }

.cp-badge {
  max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding: 2px 8px; border-radius: 999px;
  font-size: 11px; color: var(--accent);
  background: var(--accent-soft);
  border: 1px solid rgba(255,255,255,.06);
}

.cp-icon {
  width: 22px; height: 22px; line-height: 1;
  display: grid; place-items: center;
  border-radius: 7px; border: 1px solid transparent;
  background: transparent; color: var(--muted);
  font-size: 14px; cursor: pointer;
  transition: background .15s ease, color .15s ease;
}
.cp-icon:hover { background: var(--surface-strong); color: #e8ecf4; }

.cp-statusline {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px;
  font-size: 12px; color: var(--muted);
  background: rgba(0,0,0,.22);
}
.cp-statusline .cp-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--accent); flex: 0 0 auto;
}
.cp-status { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #c7cede; }
.cp-kind {
  flex: 0 0 auto; padding: 1px 6px; border-radius: 5px;
  font-size: 10.5px; font-weight: 650; line-height: 1.6;
  color: #cfd8ea; background: rgba(255, 255, 255, .1);
}
.cp-kind[hidden] { display: none; }
.cp-pct { font-variant-numeric: tabular-nums; color: var(--accent); font-weight: 600; }

.cp-body { padding: 12px; max-height: 64vh; overflow-y: auto; }
.cp-tab[hidden] { display: none; }

.cp-progress { margin-bottom: 12px; }
.cp-track {
  height: 6px; border-radius: 999px; overflow: hidden;
  background: rgba(255,255,255,.07);
}
.cp-fill {
  height: 100%; width: 0%;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--accent), #a78bfa);
  transition: width .45s cubic-bezier(.22,1,.36,1);
}
.cp-progress-meta {
  display: flex; justify-content: space-between; gap: 8px;
  margin-top: 6px; font-size: 11.5px; color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.cp-progress-meta span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 55%; text-align: right; }

.cp-row { display: flex; gap: 8px; margin-bottom: 12px; }

.cp-btn {
  flex: 1 1 0;
  padding: 8px 10px;
  border-radius: 9px;
  border: 1px solid rgba(255,255,255,.09);
  background: var(--surface);
  color: #dbe1ee;
  font-size: 12.5px; font-weight: 550;
  cursor: pointer;
  transition: transform .12s ease, background .15s ease, border-color .15s ease;
}
.cp-btn:hover { background: var(--surface-strong); border-color: rgba(255,255,255,.16); }
.cp-btn:active { transform: scale(.97); }
.cp-btn.primary {
  background: linear-gradient(135deg, rgba(94,234,212,.22), rgba(167,139,250,.2));
  border-color: rgba(94,234,212,.35);
  color: #d7fff7;
}
.cp-btn.ghost { flex: 0 0 auto; width: 100%; margin-top: 10px; background: transparent; color: var(--muted); }

.cp-speed { padding: 10px; border-radius: 11px; background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.05); }
.cp-label-row { display: flex; justify-content: space-between; align-items: baseline; font-size: 12px; color: var(--muted); }
.cp-label-row b { color: var(--accent); font-size: 15px; font-variant-numeric: tabular-nums; }
.cp-rate-wrap { display: inline-flex; align-items: center; gap: 6px; }
.cp-lock {
  font-style: normal; font-size: 10px; font-weight: 650; line-height: 1.6;
  padding: 0 7px; border-radius: 999px;
  color: var(--accent); background: var(--accent-soft);
  border: 1px solid rgba(94, 234, 212, .28);
}
.cp-lock[hidden] { display: none; }

.cp-range {
  -webkit-appearance: none; appearance: none;
  width: 100%; height: 18px; margin: 4px 0 2px;
  background: transparent; cursor: pointer;
}
.cp-range::-webkit-slider-runnable-track {
  height: 4px; border-radius: 999px;
  background: linear-gradient(90deg, rgba(94,234,212,.65), rgba(167,139,250,.5));
}
.cp-range::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 13px; height: 13px; margin-top: -4.5px;
  border-radius: 50%; background: #eef2ff;
  border: 2px solid #0b0e14;
  box-shadow: 0 0 0 3px rgba(94,234,212,.18);
}
.cp-range::-moz-range-track { height: 4px; border-radius: 999px; background: rgba(255,255,255,.16); }
.cp-range::-moz-range-thumb { width: 13px; height: 13px; border: 2px solid #0b0e14; border-radius: 50%; background: #eef2ff; }

.cp-presets { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
.cp-presets button {
  padding: 3px 8px; border-radius: 7px;
  border: 1px solid rgba(255,255,255,.08);
  background: transparent; color: var(--muted);
  font-size: 11.5px; cursor: pointer;
  transition: all .14s ease;
}
.cp-presets button:hover { color: #e8ecf4; border-color: rgba(255,255,255,.2); }
.cp-presets button.on { color: #06231f; background: var(--accent); border-color: var(--accent); font-weight: 650; }

.cp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; }
.cp-cell {
  padding: 8px 10px; border-radius: 10px;
  background: rgba(255,255,255,.03);
  border: 1px solid rgba(255,255,255,.05);
}
.cp-cell span { display: block; font-size: 11px; color: var(--muted); }
.cp-cell b { display: block; margin-top: 2px; font-size: 14px; font-variant-numeric: tabular-nums; }

.cp-materials {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin-top: 10px; padding: 7px 10px;
  border-radius: 10px;
  border: 1px dashed rgba(255, 255, 255, .14);
  background: rgba(255, 255, 255, .03);
  font-size: 12px; color: var(--muted);
}
.cp-materials > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp-materials b { color: var(--accent); font-variant-numeric: tabular-nums; }
.cp-materials[hidden] { display: none; }
.cp-btn.sm { flex: 0 0 auto; width: auto; padding: 4px 10px; font-size: 11.5px; }

.cp-switch {
  display: flex; align-items: center; justify-content: space-between;
  padding: 9px 2px; cursor: pointer;
  border-bottom: 1px solid rgba(255,255,255,.045);
}
.cp-switch span { font-size: 12.5px; color: #cdd4e2; }
.cp-switch input { position: absolute; opacity: 0; pointer-events: none; }
.cp-switch i {
  position: relative; width: 34px; height: 19px; border-radius: 999px;
  background: rgba(255,255,255,.12);
  transition: background .18s ease;
  flex: 0 0 auto;
}
.cp-switch i::after {
  content: ""; position: absolute; top: 2.5px; left: 2.5px;
  width: 14px; height: 14px; border-radius: 50%;
  background: #cfd6e4; transition: transform .18s cubic-bezier(.2,1,.3,1), background .18s ease;
}
.cp-switch input:checked + i { background: var(--accent-soft); }
.cp-switch input:checked + i::after { transform: translateX(15px); background: var(--accent); }

.cp-field { padding: 10px 2px 2px; }
.cp-field > span { display: block; font-size: 12px; color: var(--muted); }
.cp-field b { color: var(--accent); font-variant-numeric: tabular-nums; }

.cp-logs {
  list-style: none; margin: 0; padding: 0;
  height: 208px; overflow-y: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px; line-height: 1.7;
}
.cp-logs li { color: #9aa4b8; padding: 1px 0; word-break: break-all; }
.cp-logs li.cp-log-warn { color: #fbbf24; }
.cp-logs li.cp-log-error { color: #fb7185; }
.cp-logs li.cp-log-info { color: #9aa4b8; }

.cp-tabs {
  display: flex; gap: 4px; padding: 6px;
  background: rgba(0,0,0,.26);
  border-top: 1px solid rgba(255,255,255,.05);
}
.cp-tabs button {
  flex: 1 1 0; padding: 5px 0;
  border: 0; border-radius: 8px; background: transparent;
  color: var(--muted); font-size: 12px; cursor: pointer;
  transition: background .15s ease, color .15s ease;
}
.cp-tabs button:hover { color: #e8ecf4; }
.cp-tabs button.on { background: var(--surface-strong); color: #e8ecf4; }

.cp-panel[data-folded="true"] { width: 224px; }
.cp-panel[data-folded="true"] .cp-body,
.cp-panel[data-folded="true"] .cp-tabs { display: none; }
.cp-panel[data-folded="true"] .cp-statusline { padding-bottom: 9px; }

@media (prefers-reduced-motion: reduce) {
  .cp-pulse, .cp-fill { animation: none !important; transition: none !important; }
}
`;
