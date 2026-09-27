import type { Cue, EditKind, SnapResult } from '../types';
import { MIN_DURATION, SNAP_DISTANCE, clamp } from './time';

const EPS = 1e-6;

/**
 * 对排序后的字幕应用一次编辑。
 *
 * 非连锁模式：把目标块限制在「0 ≤ 起点、时长 ≥ 300ms、与左右邻居不重叠」的范围内，
 * 即遇到相邻边界或 0 时直接挡住。
 *
 * 连锁模式：允许跨越相邻边界，把产生的重叠量逐条向外传递（类似波纹），
 * 过程中每条字幕时长保持不变；若空间不足导致起点被夹到 ≥0，则反向压缩
 * 相邻块，必要时继续把重叠向外推。最终始终满足：
 *   start ≥ 0、end − start ≥ 300ms、相邻互不重叠。
 */
export function applyEdit(cues: Cue[], kind: EditKind, index: number, value: number, chain: boolean): Cue[] {
  if (index < 0 || index >= cues.length) return cues;
  const next = cues.map((c) => ({ ...c }));
  const target = next[index];

  if (kind === 'move') {
    const dur = target.end - target.start;
    target.start = Math.max(0, value);
    target.end = target.start + dur;
  } else if (kind === 'start') {
    target.start = clamp(value, 0, target.end - MIN_DURATION);
  } else {
    target.end = Math.max(value, target.start + MIN_DURATION);
  }

  if (!chain) {
    clampIntoNeighbors(next, index, kind);
    return next;
  }

  // ---- 连锁模式：先向右传播 ----
  for (let i = index; i + 1 < next.length; i++) {
    const overlap = next[i].end - next[i + 1].start;
    if (overlap <= EPS) break;
    const dur = next[i + 1].end - next[i + 1].start;
    next[i + 1].start += overlap;
    next[i + 1].end = next[i + 1].start + dur;
  }

  // ---- 再向左传播 ----
  for (let i = index; i - 1 >= 0; i--) {
    const overlap = next[i - 1].end - next[i].start;
    if (overlap <= EPS) break;
    const dur = next[i - 1].end - next[i - 1].start;
    next[i - 1].end -= overlap;
    next[i - 1].start = next[i - 1].end - dur;
  }

  // ---- 起点被推到负数：夹回 0，并向右侧波纹腾出空间 ----
  for (let i = 0; i < next.length; i++) {
    if (next[i].start < -EPS) {
      const shift = -next[i].start;
      next[i].start = 0;
      next[i].end += shift; // 时长可能被拉长，空间由后续波纹消化
    }
    if (i + 1 < next.length) {
      const overlap = next[i].end - next[i + 1].start;
      if (overlap > EPS) {
        const dur = next[i + 1].end - next[i + 1].start;
        next[i + 1].start += overlap;
        next[i + 1].end = next[i + 1].start + dur;
      }
    }
  }

  // ---- 任何块时长不足 300ms：把右边界（及后续块）向右推 ----
  for (let i = 0; i < next.length; i++) {
    if (next[i].end - next[i].start < MIN_DURATION - EPS) {
      next[i].end = next[i].start + MIN_DURATION;
      for (let j = i + 1; j < next.length; j++) {
        const overlap = next[j - 1].end - next[j].start;
        if (overlap <= EPS) break;
        const dur = next[j].end - next[j].start;
        next[j].start += overlap;
        next[j].end = next[j].start + Math.max(dur, MIN_DURATION);
      }
    }
  }

  return next;
}

/** 非连锁模式：把目标块挡在相邻边界内 */
function clampIntoNeighbors(cues: Cue[], index: number, kind: EditKind): void {
  const t = cues[index];
  const left = index > 0 ? cues[index - 1].end : 0;
  const right = index + 1 < cues.length ? cues[index + 1].start : Infinity;

  if (kind === 'end') {
    t.end = clamp(t.end, t.start + MIN_DURATION, right);
  } else if (kind === 'start') {
    t.start = clamp(t.start, left, t.end - MIN_DURATION);
  } else {
    const dur = t.end - t.start;
    t.start = clamp(t.start, left, Math.max(left, right - dur));
    t.end = t.start + dur;
  }
}

/**
 * 吸附计算：在 100ms 内把被拖曳的边/整体对齐到播放头或相邻边界。
 * 返回吸附后的起止时间与吸附位置（用于绘制吸附指示线）。
 */
export function computeSnap(
  cues: Cue[],
  index: number,
  kind: EditKind,
  start: number,
  end: number,
  playhead: number | null,
): SnapResult {
  const candidates: number[] = [];
  for (let i = 0; i < cues.length; i++) {
    if (i === index) continue;
    candidates.push(cues[i].start, cues[i].end);
  }
  if (playhead !== null) candidates.push(playhead);

  const edges: Array<['start' | 'end', number]> =
    kind === 'start'
      ? [['start', start]]
      : kind === 'end'
        ? [['end', end]]
        : [
            ['start', start],
            ['end', end],
          ];

  let best: { time: number; edge: 'start' | 'end'; delta: number } | null = null;
  for (const [edgeName, edgeTime] of edges) {
    for (const c of candidates) {
      const delta = c - edgeTime;
      if (Math.abs(delta) <= SNAP_DISTANCE + EPS && (!best || Math.abs(delta) < Math.abs(best.delta))) {
        best = { time: c, edge: edgeName, delta };
      }
    }
  }

  if (!best) return { start, end, snapTime: null };

  if (kind === 'move') {
    return {
      start: start + best.delta,
      end: end + best.delta,
      snapTime: best.time,
    };
  }
  return best.edge === 'start'
    ? { start: best.time, end, snapTime: best.time }
    : { start, end: best.time, snapTime: best.time };
}

/** 校验一组字幕是否满足全部不变量（开发/自检用） */
export function assertInvariants(cues: Cue[]): string[] {
  const errors: string[] = [];
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].start < -EPS) errors.push(`#${i} 起点 < 0`);
    if (sorted[i].end - sorted[i].start < MIN_DURATION - EPS) errors.push(`#${i} 时长 < 300ms`);
    if (i + 1 < sorted.length && sorted[i].end > sorted[i + 1].start + EPS) {
      errors.push(`#${i} 与 #${i + 1} 重叠`);
    }
  }
  return errors;
}
