import type { Cue } from '../types';
import { tokenizeCueText, type Token } from './split';

/**
 * 字幕自动换行：为单条字幕选择唯一断点，把正文折成最多两行。
 *
 * 计列规则（Unicode 显示宽度）：
 * - 每个可见码点按显示宽度计列：宽字符/全角计 2 列，组合符/控制/格式字符计 0 列，其余计 1 列；
 * - WebVTT 实体（&amp; &#65; &#x41; …）整体作为一个可见字符，按其所代表字符的显示宽度计列
 *   （未知名称或非法码点按 1 列计），实体原样保留；
 * - 内联标签（<b>…</b> 等）不计列，原样保留。
 *
 * 断点规则：
 * - 只在原文的空格（空白字符）或标点边界选断点：
 *   · 连续空白视为一个断点，换行时整段空白被替换为换行符；
 *   · 连续标点视为一个断点，换行符插在该段标点之后（标点留在第一行末尾）；
 * - 实体与标签不参与断点判断；
 * - 两行都须至少含一个可见字符（不会在首尾空白/标点处产生空行）。
 *
 * 选点规则：在满足「两行均 ≤ 每行最大列数」的候选断点中，
 * 先取两行最长宽度最小者，再取两行宽度差最小者，仍并列时取位置最靠前者（保证唯一）。
 * 找不到满足上限的断点时返回原因并禁止应用；已有换行的字幕不自动改写。
 */

// ---------- Unicode 显示宽度 ----------

/** 宽字符 / 全角字符码点区间（East Asian Wide + Fullwidth，升序不重叠） */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK 部首补充、康熙部首、表意文字描述、CJK 符号和标点
  [0x3041, 0x33ff], // 平/片假名、注音、谚文兼容字母、CJK 兼容
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 统一表意文字
  [0xa000, 0xa4cf], // 彝文
  [0xac00, 0xd7a3], // Hangul 音节
  [0xf900, 0xfaff], // CJK 兼容表意文字
  [0xfe10, 0xfe19], // 竖排形式
  [0xfe30, 0xfe6f], // CJK 兼容形式、小形式变体
  [0xff00, 0xff60], // 半角及全角形式（全角部分）
  [0xffe0, 0xffe6], // 全角符号
  [0x1f300, 0x1f64f], // 杂项符号与象形文字、表情符号
  [0x1f680, 0x1f6ff], // 交通和地图符号
  [0x1f900, 0x1f9ff], // 补充符号与象形文字
  [0x20000, 0x3fffd], // CJK 扩展 B 及以后
];

/** 码点是否为宽字符/全角（二分查找） */
export function isWideCodePoint(cp: number): boolean {
  let lo = 0;
  let hi = WIDE_RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = WIDE_RANGES[mid];
    if (cp < a) hi = mid - 1;
    else if (cp > b) lo = mid + 1;
    else return true;
  }
  return false;
}

/** 零宽：组合符（含变体选择符）、格式字符（含 ZWJ）、控制字符 */
const ZERO_WIDTH_RE = /[\p{Mn}\p{Me}\p{Cf}\p{Cc}]/u;

/** 单个码点的显示列宽：宽字符计 2，零宽字符计 0，其余计 1 */
export function charDisplayWidth(cp: number): number {
  if (ZERO_WIDTH_RE.test(String.fromCodePoint(cp))) return 0;
  return isWideCodePoint(cp) ? 2 : 1;
}

// ---------- 实体 ----------

/** 已知命名实体所代表的字符（WebVTT 规定的 amp/lt/gt/lrm/rlm/nbsp 及常见 quot/apos） */
const NAMED_ENTITY_CHARS: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  lrm: '\u200e',
  rlm: '\u200f',
};

/** 实体的显示列宽：作为一个可见字符，按其所代表字符计列；未知名称/非法码点按 1 列计 */
export function entityDisplayWidth(raw: string): number {
  const m = raw.match(/^&(?:([A-Za-z][A-Za-z0-9]*)|#([0-9]+)|#[xX]([0-9A-Fa-f]+));$/);
  if (!m) return 1;
  if (m[1] !== undefined) {
    const ch = NAMED_ENTITY_CHARS[m[1].toLowerCase()];
    return ch === undefined ? 1 : charDisplayWidth(ch.codePointAt(0)!);
  }
  const cp = parseInt(m[2] !== undefined ? m[2] : m[3], m[2] !== undefined ? 10 : 16);
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return 1;
  return charDisplayWidth(cp);
}

// ---------- 可见单位 ----------

const SPACE_RE = /\p{White_Space}/u;
const PUNCT_RE = /\p{P}/u;

interface UnitInfo {
  width: number; // 显示列宽（标签为 0）
  visible: boolean; // 是否为可见字符（char/entity）
  space: boolean; // 空白字符（可作为断点）
  punct: boolean; // 标点字符（其后可作为断点）
}

function unitOf(t: Token): UnitInfo {
  if (t.kind === 'open' || t.kind === 'close') {
    return { width: 0, visible: false, space: false, punct: false };
  }
  if (t.kind === 'entity') {
    // 实体作为一个可见字符，但不参与断点判断
    return { width: entityDisplayWidth(t.value), visible: true, space: false, punct: false };
  }
  const cp = t.value.codePointAt(0)!;
  return {
    width: charDisplayWidth(cp),
    visible: true,
    space: SPACE_RE.test(t.value),
    punct: PUNCT_RE.test(t.value),
  };
}

interface WrapAnalysis {
  tokens: Token[];
  units: UnitInfo[];
  totalWidth: number;
  totalVisible: number;
}

/** 校验标签并统计各可见单位的宽度/属性（标签校验复用拆分的规则） */
function analyzeTokens(text: string): WrapAnalysis | { error: string } {
  const r = tokenizeCueText(text);
  if ('error' in r) return { error: r.error };
  const units = r.tokens.map(unitOf);
  let totalWidth = 0;
  let totalVisible = 0;
  for (const u of units) {
    totalWidth += u.width;
    if (u.visible) totalVisible++;
  }
  return { tokens: r.tokens, units, totalWidth, totalVisible };
}

export type WrapAnalysisResult =
  | { ok: true; totalWidth: number; visible: number }
  | { ok: false; error: string };

/** 供弹窗在输入列数前展示总列数 / 不可换行原因 */
export function analyzeWrap(cue: Cue): WrapAnalysisResult {
  if (/[\r\n]/.test(cue.text)) return { ok: false, error: '该字幕已有换行，不自动改写' };
  const a = analyzeTokens(cue.text);
  if ('error' in a) return { ok: false, error: a.error };
  return { ok: true, totalWidth: a.totalWidth, visible: a.totalVisible };
}

// ---------- 断点 ----------

interface BreakPoint {
  kind: 'space' | 'punct';
  /** space：被整段替换为换行的空白 token 区间 [from, to]；punct：在 token from(=to) 之后插入换行 */
  from: number;
  to: number;
  leftWidth: number;
  rightWidth: number;
}

/** 枚举全部候选断点（按 token 顺序，即从左到右） */
function findBreakPoints(a: WrapAnalysis): BreakPoint[] {
  const { units } = a;
  const n = units.length;
  // 前缀和：宽度与可见字符数
  const prefW = new Array<number>(n + 1).fill(0);
  const prefV = new Array<number>(n + 1).fill(0);
  for (let i = 0; i < n; i++) {
    prefW[i + 1] = prefW[i] + units[i].width;
    prefV[i + 1] = prefV[i] + (units[i].visible ? 1 : 0);
  }
  const totalW = prefW[n];
  const totalV = prefV[n];

  const points: BreakPoint[] = [];
  let i = 0;
  while (i < n) {
    const u = units[i];
    if (u.space) {
      let j = i;
      while (j + 1 < n && units[j + 1].space) j++;
      // 连续空白段 [i..j] 整段替换为换行；两侧都须有可见字符
      if (prefV[i] > 0 && totalV - prefV[j + 1] > 0) {
        points.push({
          kind: 'space',
          from: i,
          to: j,
          leftWidth: prefW[i],
          rightWidth: totalW - prefW[j + 1],
        });
      }
      i = j + 1;
    } else if (u.punct) {
      let j = i;
      while (j + 1 < n && units[j + 1].punct) j++;
      // 在连续标点段末尾之后断行；两侧都须有可见字符
      if (prefV[j + 1] > 0 && totalV - prefV[j + 1] > 0) {
        points.push({
          kind: 'punct',
          from: j,
          to: j,
          leftWidth: prefW[j + 1],
          rightWidth: totalW - prefW[j + 1],
        });
      }
      i = j + 1;
    } else {
      i++;
    }
  }
  return points;
}

/** 渲染 token 区间 [from, to) 为原文（标签/实体原样保留） */
function renderTokens(tokens: Token[], from: number, to: number): string {
  let s = '';
  for (let i = from; i < to; i++) {
    const t = tokens[i];
    s += t.kind === 'char' || t.kind === 'entity' ? t.value : t.raw;
  }
  return s;
}

/** 按断点生成两行正文与换行后的完整文本 */
function buildWrappedText(
  tokens: Token[],
  bp: BreakPoint,
): { line1: string; line2: string; newText: string } {
  if (bp.kind === 'space') {
    const line1 = renderTokens(tokens, 0, bp.from);
    const line2 = renderTokens(tokens, bp.to + 1, tokens.length);
    return { line1, line2, newText: `${line1}\n${line2}` };
  }
  const line1 = renderTokens(tokens, 0, bp.from + 1);
  const line2 = renderTokens(tokens, bp.from + 1, tokens.length);
  return { line1, line2, newText: `${line1}\n${line2}` };
}

// ---------- 预览 / 应用 ----------

export interface WrapPreview {
  maxCols: number; // 每行最大列数
  totalWidth: number; // 全文可见总列数
  kind: 'space' | 'punct'; // 选中的断点类型
  line1: string;
  line2: string;
  line1Width: number;
  line2Width: number;
  newText: string; // 应用后的正文（恰好两行）
  feasibleCount: number; // 满足上限的候选断点数
}

export type WrapResult = { ok: true; preview: WrapPreview } | { ok: false; error: string };

/**
 * 预览按每行最大列数自动换行：
 * - maxCols 须为正整数；已有换行的字幕不自动改写；
 * - 全文已不超过上限时不产生换行（无需换行）；
 * - 只在空格/标点边界选断点，满足「两行均 ≤ maxCols」的候选中，
 *   以「最长宽度最小 → 宽度差最小 → 位置最靠前」确定唯一断点；
 * - 找不到满足上限的断点时返回原因（禁止应用）。
 */
export function previewWrap(cue: Cue, maxCols: number): WrapResult {
  if (!Number.isInteger(maxCols) || maxCols < 1) {
    return { ok: false, error: '每行最大列数须为正整数' };
  }
  if (/[\r\n]/.test(cue.text)) {
    return { ok: false, error: '该字幕已有换行，不自动改写' };
  }
  const a = analyzeTokens(cue.text);
  if ('error' in a) return { ok: false, error: a.error };
  if (a.totalVisible === 0) {
    return { ok: false, error: '正文没有可见字符，无需换行' };
  }
  if (a.totalWidth <= maxCols) {
    return { ok: false, error: `全文共 ${a.totalWidth} 列，已不超过每行 ${maxCols} 列，无需换行` };
  }

  const points = findBreakPoints(a);
  if (points.length === 0) {
    return { ok: false, error: '正文中没有空格或标点边界可作为断点，无法自动换行' };
  }

  const feasible = points.filter((p) => p.leftWidth <= maxCols && p.rightWidth <= maxCols);
  if (feasible.length === 0) {
    const best = Math.min(...points.map((p) => Math.max(p.leftWidth, p.rightWidth)));
    return {
      ok: false,
      error: `找不到满足上限的断点：${points.length} 个候选断点中最优的较长行仍为 ${best} 列，超过每行 ${maxCols} 列，禁止应用`,
    };
  }

  // 唯一选点：最长宽度最小 → 宽度差最小 → 位置最靠前（feasible 已按位置排序，严格小于才替换）
  let best = feasible[0];
  let bestKey = selectKey(best);
  for (const p of feasible.slice(1)) {
    const k = selectKey(p);
    if (k[0] < bestKey[0] || (k[0] === bestKey[0] && k[1] < bestKey[1])) {
      best = p;
      bestKey = k;
    }
  }

  const { line1, line2, newText } = buildWrappedText(a.tokens, best);
  return {
    ok: true,
    preview: {
      maxCols,
      totalWidth: a.totalWidth,
      kind: best.kind,
      line1,
      line2,
      line1Width: best.leftWidth,
      line2Width: best.rightWidth,
      newText,
      feasibleCount: feasible.length,
    },
  };
}

function selectKey(p: BreakPoint): [number, number] {
  return [Math.max(p.leftWidth, p.rightWidth), Math.abs(p.leftWidth - p.rightWidth)];
}

/**
 * 应用自动换行：返回该条字幕的新正文（仅正文变化，id 与起止时间由调用方保留）。
 * 校验不通过时返回 null（调用方应阻止提交）。
 */
export function wrapCue(cue: Cue, maxCols: number): { newText: string } | null {
  const r = previewWrap(cue, maxCols);
  return r.ok ? { newText: r.preview.newText } : null;
}
