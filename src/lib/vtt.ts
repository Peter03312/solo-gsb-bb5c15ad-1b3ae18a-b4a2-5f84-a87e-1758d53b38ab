import type { Cue } from '../types';
import { MIN_DURATION, parseTimestamp } from './time';

function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `cue-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * 解析 WebVTT 文本。
 * 容错策略：忽略 WEBVTT 头、NOTE/REGION/STYLE 块与孤立设置行；
 * 无法识别的行不会抛出错误，只跳过。
 */
export function parseVtt(input: string): Cue[] {
  const stripped = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rawLines = stripped.split(/\r?\n/);
  const cues: Cue[] = [];
  let i = 0;

  // 跳过文件头（WEBVTT ...）
  if (i < rawLines.length && /^WEBVTT/i.test(rawLines[i].trim())) i++;

  while (i < rawLines.length) {
    const line = rawLines[i].trim();

    if (line === '') {
      i++;
      continue;
    }
    // 跳过 NOTE / REGION / STYLE 块（直到空行）
    if (/^(NOTE|REGION|STYLE)(\s|$)/i.test(line)) {
      i++;
      while (i < rawLines.length && rawLines[i].trim() !== '') i++;
      continue;
    }

    let id: string | null = null;
    let timingLine = line;

    // 时间行形如 00:00:01.000 --> 00:00:03.000
    if (!line.includes('-->')) {
      id = line;
      i++;
      if (i >= rawLines.length) break;
      timingLine = rawLines[i].trim();
    }

    const tm = timingLine.match(/^(\S+)\s*-->\s*(\S+)/);
    if (!tm) {
      // 不是合法时间块，跳过这一行继续
      i++;
      continue;
    }
    const start = parseTimestamp(tm[1]);
    const end = parseTimestamp(tm[2]);
    if (start === null || end === null || end < start + MIN_DURATION - 1e-6) {
      i++;
      continue;
    }

    i++; // 消费时间行
    const textLines: string[] = [];
    while (i < rawLines.length && rawLines[i].trim() !== '') {
      textLines.push(rawLines[i]);
      i++;
    }

    cues.push({
      id: id ?? makeId(),
      start,
      end,
      text: textLines.join('\n'),
    });
  }

  // 按起点排序，保证时间轴顺序不变量
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  return cues;
}

/** 序列化为标准 WebVTT（按时间轴顺序，保留原始 id） */
export function serializeVtt(cues: Cue[]): string {
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  const lines: string[] = ['WEBVTT', ''];
  for (const cue of sorted) {
    lines.push(cue.id);
    lines.push(
      `${formatTs(cue.start)} --> ${formatTs(cue.end)}`,
    );
    lines.push(cue.text.trim() === '' ? ' ' : cue.text);
    lines.push('');
  }
  return lines.join('\n');
}

function formatTs(s: number): string {
  // 内联一份，避免循环依赖顾虑
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)}.${pad(ms, 3)}`;
}
