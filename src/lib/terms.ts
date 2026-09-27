import type { Cue } from '../types';

/** 一条术语替换规则：原词 → 推荐词（均须非空，原词不可重复） */
export interface TermRule {
  id: string;
  source: string; // 原词（区分大小写的字面匹配）
  target: string; // 推荐词
}

/** 一次命中：在字幕原文中的区间与替换内容 */
export interface TermHit {
  start: number; // 命中在 cue.text 中的起始下标（含）
  end: number; // 结束下标（不含）
  source: string; // 命中的原词
  target: string; // 替换为的推荐词
}

export interface TermReplacement {
  newText: string;
  hits: TermHit[]; // 原文中的命中区间（有序、互不重叠）
  newRanges: Array<{ start: number; end: number }>; // 替换后正文中的对应区间（与 hits 一一对应）
}

export interface TermPreviewRow {
  cue: Cue;
  hits: TermHit[];
  newText: string;
  newRanges: Array<{ start: number; end: number }>;
}

/**
 * WebVTT 内联标签（<b>、</i>、<c.foo>、<v 说话人>、<00:00:01.000> 等）
 * 与实体（&amp; &lt; &#65; 等）一律视为边界：不参与匹配、原样保留。
 */
const BOUNDARY_RE = /<[^>]*>|&(?:[A-Za-z][A-Za-z0-9]*|#[0-9]+|#[xX][0-9A-Fa-f]+);/g;

interface Segment {
  kind: 'text' | 'boundary';
  value: string;
  offset: number; // 在原文中的起始下标
}

/** 把字幕正文切分为「可见文本段」与「边界段」（标签/实体） */
function segmentText(text: string): Segment[] {
  const segs: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(BOUNDARY_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) segs.push({ kind: 'text', value: text.slice(last, idx), offset: last });
    segs.push({ kind: 'boundary', value: m[0], offset: idx });
    last = idx + m[0].length;
  }
  if (last < text.length) segs.push({ kind: 'text', value: text.slice(last), offset: last });
  return segs;
}

/** 过滤出可参与匹配的规则（原词非空；空原词会导致零宽死循环，必须排除） */
export function effectiveRules(rules: TermRule[]): TermRule[] {
  return rules.filter((r) => r.source.trim() !== '' && r.target.trim() !== '');
}

/**
 * 校验规则表：
 * - 整行留空（原词与推荐词都为空白）的行被忽略；
 * - 只填一半 → 报错（原词和推荐词均须非空）；
 * - 原词重复 → 报错。
 * 返回错误信息，合法时返回 null。
 */
export function validateRules(rules: TermRule[]): string | null {
  const seen = new Set<string>();
  for (const r of rules) {
    const srcEmpty = r.source.trim() === '';
    const tgtEmpty = r.target.trim() === '';
    if (srcEmpty && tgtEmpty) continue;
    if (srcEmpty || tgtEmpty) return '原词和推荐词均不能为空（整行留空可忽略该行）';
    if (seen.has(r.source)) return `原词重复：「${r.source}」`;
    seen.add(r.source);
  }
  return null;
}

/**
 * 对一段字幕正文执行术语替换。
 *
 * 匹配语义：
 * - 仅在可见文本段内做区分大小写的字面匹配，标签/实体边界不可跨越、原样保留；
 * - 从左到右扫描，同一位置多条规则命中时取最长原词，等长按规则顺序（靠前者优先）；
 * - 已匹配的字符立即被消费，不再参与后续匹配（命中互不重叠）。
 */
export function replaceTerms(text: string, rules: TermRule[]): TermReplacement {
  const active = rules.filter((r) => r.source.length > 0);
  const hits: TermHit[] = [];
  const newRanges: Array<{ start: number; end: number }> = [];
  if (active.length === 0) return { newText: text, hits, newRanges };

  let out = '';
  for (const seg of segmentText(text)) {
    if (seg.kind === 'boundary') {
      out += seg.value; // 边界原样保留
      continue;
    }
    const s = seg.value;
    let i = 0;
    while (i < s.length) {
      let best: TermRule | null = null;
      for (const r of active) {
        if (r.source.length <= s.length - i && s.startsWith(r.source, i)) {
          // 严格更长才替换 ⇒ 等长时保留规则顺序中靠前者
          if (!best || r.source.length > best.source.length) best = r;
        }
      }
      if (best) {
        hits.push({
          start: seg.offset + i,
          end: seg.offset + i + best.source.length,
          source: best.source,
          target: best.target,
        });
        newRanges.push({ start: out.length, end: out.length + best.target.length });
        out += best.target;
        i += best.source.length; // 已选中的字符不再重复匹配
      } else {
        out += s[i];
        i++;
      }
    }
  }
  return { newText: out, hits, newRanges };
}

/** 逐条预览：只返回有命中的字幕（按时间轴顺序），包含命中位置与替换后正文 */
export function previewTerms(cues: Cue[], rules: TermRule[]): TermPreviewRow[] {
  const active = effectiveRules(rules);
  if (active.length === 0) return [];
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  const rows: TermPreviewRow[] = [];
  for (const cue of sorted) {
    const r = replaceTerms(cue.text, active);
    if (r.hits.length > 0) {
      rows.push({ cue, hits: r.hits, newText: r.newText, newRanges: r.newRanges });
    }
  }
  return rows;
}

/**
 * 应用替换：仅改写所勾选字幕的文本，id 与时间保持不变。
 * 无任何实际改动时原样返回（相同引用 ⇒ 撤销历史不产生记录）。
 */
export function applyTerms(cues: Cue[], rules: TermRule[], selectedIds: ReadonlySet<string>): Cue[] {
  const active = effectiveRules(rules);
  if (active.length === 0 || selectedIds.size === 0) return cues;
  let changed = false;
  const next = cues.map((c) => {
    if (!selectedIds.has(c.id)) return c;
    const r = replaceTerms(c.text, active);
    if (r.hits.length === 0 || r.newText === c.text) return c;
    changed = true;
    return { ...c, text: r.newText };
  });
  return changed ? next : cues;
}
