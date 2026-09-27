import type { Cue } from '../types';
import { MIN_DURATION } from './time';

const EPS = 1e-6;

/** 一组锚点：旧版时间 → 新版时间（秒） */
export interface Anchor {
  oldTime: number;
  newTime: number;
}

export type RemapIssueKind = 'negative-start' | 'short-duration' | 'overlap';

export interface RemapIssue {
  cueId: string;
  index: number; // 预览行（按映射后顺序）下标
  kind: RemapIssueKind;
  detail: string;
}

export interface RemapPreviewRow {
  cue: Cue;
  newStart: number;
  newEnd: number;
  issues: RemapIssueKind[];
}

export interface RemapPreview {
  rows: RemapPreviewRow[];
  issues: RemapIssue[];
  ok: boolean; // 无任何问题时才允许应用
}

/** 校验锚点：至少两组，且旧版/新版时间各自严格递增。返回错误信息或 null。 */
export function validateAnchors(anchors: Anchor[]): string | null {
  if (anchors.length < 2) return '至少需要 2 组锚点';
  for (let i = 1; i < anchors.length; i++) {
    if (!(anchors[i].oldTime > anchors[i - 1].oldTime)) return '旧版时间必须严格递增';
    if (!(anchors[i].newTime > anchors[i - 1].newTime)) return '新版时间必须严格递增';
  }
  return null;
}

/**
 * 分段线性映射：相邻锚点之间线性插值；
 * 首锚点左侧 / 末锚点右侧分别按第一段 / 最后一段的斜率外推。
 * 锚点两侧严格递增 ⇒ 每段斜率 > 0 ⇒ 映射严格单调递增，字幕顺序保持不变。
 */
export function mapTime(anchors: Anchor[], t: number): number {
  const n = anchors.length;
  if (t <= anchors[0].oldTime) {
    return anchors[0].newTime + (t - anchors[0].oldTime) * segmentSlope(anchors, 0);
  }
  if (t >= anchors[n - 1].oldTime) {
    return anchors[n - 1].newTime + (t - anchors[n - 1].oldTime) * segmentSlope(anchors, n - 2);
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid].oldTime <= t) lo = mid;
    else hi = mid;
  }
  return anchors[lo].newTime + (t - anchors[lo].oldTime) * segmentSlope(anchors, lo);
}

function segmentSlope(anchors: Anchor[], i: number): number {
  const a = anchors[i];
  const b = anchors[i + 1];
  return (b.newTime - a.newTime) / (b.oldTime - a.oldTime);
}

/**
 * 计算映射预览：逐条给出新起止时间，并标出全部问题
 * （负起点 / 时长不足 300ms / 与相邻字幕重叠，重叠时两条都标）。
 */
export function previewRemap(cues: Cue[], anchors: Anchor[]): RemapPreview {
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  const rows: RemapPreviewRow[] = sorted.map((cue) => ({
    cue,
    newStart: mapTime(anchors, cue.start),
    newEnd: mapTime(anchors, cue.end),
    issues: [],
  }));

  const issues: RemapIssue[] = [];
  const push = (row: RemapPreviewRow, index: number, kind: RemapIssueKind, detail: string) => {
    if (!row.issues.includes(kind)) row.issues.push(kind);
    issues.push({ cueId: row.cue.id, index, kind, detail });
  };

  rows.forEach((row, i) => {
    if (row.newStart < -EPS) {
      push(row, i, 'negative-start', '映射后起点为负');
    }
    if (row.newEnd - row.newStart < MIN_DURATION - EPS) {
      push(row, i, 'short-duration', '映射后时长不足 300ms');
    }
    if (i + 1 < rows.length && row.newEnd > rows[i + 1].newStart + EPS) {
      push(row, i, 'overlap', `与第 ${i + 2} 条重叠`);
      push(rows[i + 1], i + 1, 'overlap', `与第 ${i + 1} 条重叠`);
    }
  });

  return { rows, issues, ok: issues.length === 0 };
}

/**
 * 应用映射：保留每条字幕的 id 与文本，仅替换起止时间。
 * 预览未通过时原样返回（配合撤销历史：相同引用不产生记录）。
 */
export function applyRemap(cues: Cue[], anchors: Anchor[]): Cue[] {
  const preview = previewRemap(cues, anchors);
  if (!preview.ok) return cues;
  return preview.rows.map((row) => ({ ...row.cue, start: row.newStart, end: row.newEnd }));
}
