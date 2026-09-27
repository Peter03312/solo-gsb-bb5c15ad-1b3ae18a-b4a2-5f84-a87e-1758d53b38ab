export const MIN_DURATION = 0.3; // 每条字幕至少 300ms
export const SNAP_DISTANCE = 0.1; // 100ms 吸附阈值

/** 把秒数格式化为 HH:MM:SS.mmm（WebVTT 时间戳） */
export function formatTimestamp(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)}.${pad(ms, 3)}`;
}

/** 解析 WebVTT 时间戳（HH:MM:SS.mmm / MM:SS.mmm，分隔符 . 或 ,） */
export function parseTimestamp(input: string): number | null {
  const m = input.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
  if (!m) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const min = parseInt(m[2], 10);
  const sec = parseInt(m[3], 10);
  const ms = parseInt(m[4].padEnd(3, '0'), 10);
  if (min >= 60 || sec >= 60) return null;
  return h * 3600 + min * 60 + sec + ms / 1000;
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
