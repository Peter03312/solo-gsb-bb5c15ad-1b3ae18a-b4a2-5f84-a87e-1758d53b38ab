import type { Cue } from '../types';
import { MIN_DURATION } from './time';

const EPS = 1e-6;

/**
 * 字幕拆分：按可见字数 N 把一条字幕拆成首尾相接的两条。
 *
 * 计数规则（可见单位）：
 * - 每个 Unicode 码点计 1（含换行 \n，按码点而非 UTF-16 码元计）；
 * - WebVTT 命名实体（&amp;）与数字实体（&#65; / &#x41;）各计 1，原样保留；
 * - 内联标签（<b>…</b> 等）不计。
 *
 * 标签规则：
 * - 仅支持正确嵌套的 b / i / u / c / v / lang 标签（可带 class 与注解，如 <c.foo>、<v 说话人>）；
 * - 未知标签、不配对/未闭合标签、内联时间戳（<00:00:01.000>）一律报错并禁止应用；
 * - 切点处仍开放的标签：左段按嵌套逆序闭合，右段按原顺序原样重开；
 * - 紧跟切点的闭合标签并入左段（不会在右段产生空标签对）。
 */

/** 支持的标签名（匹配时不区分大小写，输出保留原文） */
const KNOWN_TAGS = new Set(['b', 'i', 'u', 'c', 'v', 'lang']);

/** 实体：命名 / 十进制 / 十六进制，整体计 1 字 */
const ENTITY_RE = /&(?:[A-Za-z][A-Za-z0-9]*|#[0-9]+|#[xX][0-9A-Fa-f]+);/y;

/** 标签候选：<...>（到第一个 > 为止） */
const TAG_RE = /<[^>]*>/y;

/** 内联时间戳，如 00:00:01.000 */
const TIMESTAMP_RE = /^\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}/;

export type Token =
  | { kind: 'char'; value: string } // 单个可见码点（含换行）
  | { kind: 'entity'; value: string } // 实体，整体计 1
  | { kind: 'open'; name: string; raw: string } // 开标签（raw 为原文）
  | { kind: 'close'; name: string; raw: string }; // 闭标签

/**
 * 把字幕正文切分为 token 流，并校验标签合法性。
 * 校验失败返回 { error }；通过则返回 tokens（标签配对与嵌套已确认合法）。
 */
export function tokenizeCueText(text: string): { tokens: Token[] } | { error: string } {
  const tokens: Token[] = [];
  const stack: Array<{ name: string; raw: string }> = [];
  let i = 0;

  while (i < text.length) {
    if (text[i] === '<') {
      TAG_RE.lastIndex = i;
      const m = TAG_RE.exec(text);
      if (m) {
        const raw = m[0];
        const inner = raw.slice(1, -1);
        if (TIMESTAMP_RE.test(inner)) {
          return { error: `含有内联时间戳 ${raw}，请先移除后再拆分` };
        }
        const closeM = inner.match(/^\/([A-Za-z][A-Za-z0-9]*)$/);
        if (closeM) {
          const name = closeM[1];
          if (!KNOWN_TAGS.has(name.toLowerCase())) return { error: `不支持的标签 ${raw}` };
          const top = stack[stack.length - 1];
          if (!top) return { error: `标签不配对：${raw} 没有对应的开标签` };
          if (top.name.toLowerCase() !== name.toLowerCase()) {
            return { error: `标签不配对：${raw} 与 ${top.raw} 嵌套错误` };
          }
          stack.pop();
          tokens.push({ kind: 'close', name, raw });
        } else {
          const openM = inner.match(/^([A-Za-z][A-Za-z0-9]*)(?:[.\s][\s\S]*)?$/);
          if (!openM) return { error: `无法识别的标签 ${raw}` };
          const name = openM[1];
          if (!KNOWN_TAGS.has(name.toLowerCase())) return { error: `不支持的标签 ${raw}` };
          stack.push({ name, raw });
          tokens.push({ kind: 'open', name, raw });
        }
        i += raw.length;
        continue;
      }
      // 裸 '<'（后面没有 >）：按可见文本处理
    }

    ENTITY_RE.lastIndex = i;
    const em = ENTITY_RE.exec(text);
    if (em) {
      tokens.push({ kind: 'entity', value: em[0] });
      i += em[0].length;
      continue;
    }

    // 普通字符：按码点取一个（正确处理代理对）
    const cp = String.fromCodePoint(text.codePointAt(i)!);
    tokens.push({ kind: 'char', value: cp });
    i += cp.length;
  }

  if (stack.length > 0) {
    return { error: `标签未闭合：${stack[stack.length - 1].raw}` };
  }
  return { tokens };
}

/** 可见单位总数（标签不计；实体各计 1；其余每码点计 1，含换行） */
function countVisible(tokens: Token[]): number {
  let n = 0;
  for (const t of tokens) {
    if (t.kind === 'char' || t.kind === 'entity') n++;
  }
  return n;
}

/**
 * 分析字幕正文：校验标签并统计可见字数。
 * 供弹窗在输入切点前展示总字数 / 标签错误。
 */
export function analyzeCueText(text: string): { ok: true; total: number } | { ok: false; error: string } {
  const r = tokenizeCueText(text);
  if ('error' in r) return { ok: false, error: r.error };
  return { ok: true, total: countVisible(r.tokens) };
}

/**
 * 在第 N 个可见单位之后切断 token 流，生成左右两段正文。
 * 前提：tokens 已通过校验，且 1 ≤ N ≤ 可见总数 − 1。
 */
function buildSegments(tokens: Token[], n: number): { left: string; right: string } {
  const leftParts: string[] = [];
  const rightParts: string[] = [];
  const openStack: Array<{ name: string; raw: string }> = [];
  let count = 0;
  let idx = 0;

  // 左段：消费到第 N 个可见单位为止
  for (; idx < tokens.length; idx++) {
    const t = tokens[idx];
    if (t.kind === 'open') {
      openStack.push(t);
      leftParts.push(t.raw);
    } else if (t.kind === 'close') {
      openStack.pop();
      leftParts.push(t.raw);
    } else {
      leftParts.push(t.value);
      count++;
    }
    if (count === n) {
      idx++;
      break;
    }
  }

  // 紧跟切点的闭合标签并入左段（校验已保证其与栈顶匹配）
  for (; idx < tokens.length; idx++) {
    const t = tokens[idx];
    if (
      t.kind === 'close' &&
      openStack.length > 0 &&
      openStack[openStack.length - 1].name.toLowerCase() === t.name.toLowerCase()
    ) {
      openStack.pop();
      leftParts.push(t.raw);
    } else {
      break;
    }
  }

  // 切点处仍开放的标签：左段按嵌套逆序闭合，右段按原顺序原样重开
  for (const t of openStack) rightParts.push(t.raw);
  for (let i = openStack.length - 1; i >= 0; i--) leftParts.push(`</${openStack[i].name}>`);

  // 其余 token 全部进入右段
  for (; idx < tokens.length; idx++) {
    const t = tokens[idx];
    rightParts.push(t.kind === 'char' || t.kind === 'entity' ? t.value : t.raw);
  }

  return { left: leftParts.join(''), right: rightParts.join('') };
}

export interface SplitPreview {
  total: number; // 可见总字数
  leftText: string;
  rightText: string;
  leftCount: number; // = N
  rightCount: number; // = total − N
  splitTime: number; // 分割点（秒，已四舍五入到毫秒）
  leftStart: number;
  leftEnd: number;
  rightStart: number;
  rightEnd: number;
}

export type SplitResult = { ok: true; preview: SplitPreview } | { ok: false; error: string };

/**
 * 预览按第 N 个可见单位拆分：
 * - N 须为整数，且两段均非空（1 ≤ N ≤ 总字数 − 1）；
 * - 分割时间 = 原起点 + 原时长 × N / 总字数，四舍五入到毫秒；
 * - 两段首尾相接、保留原起止；任一段不足 300ms 则报错禁止应用。
 */
export function previewSplit(cue: Cue, n: number): SplitResult {
  const tok = tokenizeCueText(cue.text);
  if ('error' in tok) return { ok: false, error: tok.error };
  const total = countVisible(tok.tokens);

  if (!Number.isInteger(n)) return { ok: false, error: '切点 N 必须是整数' };
  if (total < 2) return { ok: false, error: `可见字数仅 ${total}，不足两字，无法拆分` };
  if (n < 1 || n > total - 1) {
    return { ok: false, error: `切点须在 1 ~ ${total - 1} 之间（两段均须非空）` };
  }

  const { left, right } = buildSegments(tok.tokens, n);

  const splitTime =
    Math.round((cue.start + (cue.end - cue.start) * (n / total)) * 1000) / 1000;
  const leftDur = splitTime - cue.start;
  const rightDur = cue.end - splitTime;
  if (leftDur < MIN_DURATION - EPS || rightDur < MIN_DURATION - EPS) {
    const fmt = (s: number) => `${Math.round(s * 1000)}ms`;
    return {
      ok: false,
      error: `拆分后时长不足 300ms（左段 ${fmt(leftDur)} / 右段 ${fmt(rightDur)}），禁止应用`,
    };
  }

  return {
    ok: true,
    preview: {
      total,
      leftText: left,
      rightText: right,
      leftCount: n,
      rightCount: total - n,
      splitTime,
      leftStart: cue.start,
      leftEnd: splitTime,
      rightStart: splitTime,
      rightEnd: cue.end,
    },
  };
}

/**
 * 应用拆分：用两条新 id 的字幕替换原条（保留原起止，首尾相接）。
 * 校验不通过时返回 null（调用方应阻止提交）。
 */
export function splitCue(cue: Cue, n: number, idGen: () => string): Cue[] | null {
  const r = previewSplit(cue, n);
  if (!r.ok) return null;
  const p = r.preview;
  return [
    { ...cue, id: idGen(), end: p.splitTime, text: p.leftText },
    { ...cue, id: idGen(), start: p.splitTime, text: p.rightText },
  ];
}
