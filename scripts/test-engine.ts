import assert from 'node:assert';
import type { Cue } from '../src/types';
import { applyEdit, computeSnap, assertInvariants } from '../src/lib/engine';
import { parseVtt, serializeVtt } from '../src/lib/vtt';
import { parseTimestamp, formatTimestamp, MIN_DURATION, SNAP_DISTANCE } from '../src/lib/time';
import { validateAnchors, mapTime, previewRemap, applyRemap } from '../src/lib/remap';
import {
  validateRules,
  effectiveRules,
  replaceTerms,
  previewTerms,
  applyTerms,
  type TermRule,
} from '../src/lib/terms';
import { analyzeCueText, previewSplit, splitCue } from '../src/lib/split';
import {
  charDisplayWidth,
  entityDisplayWidth,
  analyzeWrap,
  previewWrap,
  wrapCue,
} from '../src/lib/wrap';

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`✓ ${name}`);
}

function mkCues(spec: Array<[number, number]>): Cue[] {
  return spec.map(([start, end], i) => ({
    id: `c${i}`,
    start,
    end,
    text: `cue ${i}`,
  }));
}

function expectValid(cues: Cue[]) {
  const errors = assertInvariants(cues);
  assert(errors.length === 0, `invariants broken: ${errors.join('; ')}`);
}

// ---------- 基础不变量 ----------
test('初始示例数据合法', () => {
  const cues = mkCues([
    [0.5, 3],
    [3.2, 6],
    [6.3, 9.5],
  ]);
  expectValid(cues);
});

// ---------- 非连锁：被邻居挡住 ----------
test('非连锁模式右移被右邻边界挡住', () => {
  const cues = mkCues([
    [0, 1],
    [2, 3],
  ]);
  const next = applyEdit(cues, 'move', 0, 10, false);
  expectValid(next);
  assert.equal(next[0].end, next[1].start);
});

test('非连锁模式拖动起点被左邻挡住', () => {
  const cues = mkCues([
    [0, 1],
    [2, 5],
  ]);
  const next = applyEdit(cues, 'start', 1, -5, false);
  expectValid(next);
  assert.equal(next[1].start, 1);
});

test('非连锁拖 end 保留至少 300ms 且不越界', () => {
  const cues = mkCues([
    [0, 1],
    [1.5, 3],
  ]);
  const next = applyEdit(cues, 'end', 0, 100, false);
  expectValid(next);
  assert.equal(next[0].end, next[1].start);
  const next2 = applyEdit(cues, 'start', 0, 100, false);
  assert(next2[0].end - next2[0].start >= MIN_DURATION - 1e-6);
});

// ---------- 连锁：重叠逐条传递 ----------
test('连锁模式右推：重叠逐条传递，各条时长不变', () => {
  const cues = mkCues([
    [0, 1],
    [2, 3.5],
    [4.5, 6],
  ]);
  const durations = cues.map((c) => c.end - c.start);
  // 把第一条终点拖到 4（与第2条重叠 2s，第2条再推第3条）
  const next = applyEdit(cues, 'end', 0, 4, true);
  expectValid(next);
  assert.equal(next[0].end, 4);
  // 第2条被推到 4 开始
  assert.equal(next[1].start, 4);
  assert.equal(next[1].end, 5.5);
  // 第3条应被推到 5.5
  assert.equal(next[2].start, 5.5);
  assert.equal(next[2].end, 7);
  // 目标条时长变为 4s；被推动的邻居时长保持不变
  assert.equal(next[0].end - next[0].start, 4);
  for (let i = 1; i < next.length; i++) {
    assert(Math.abs(next[i].end - next[i].start - durations[i]) < 1e-9);
  }
});

test('连锁模式左推：重叠向左传递，邻居时长保持', () => {
  const cues = mkCues([
    [0, 2],
    [3, 5],
    [6, 7],
  ]);
  const durations = cues.map((c) => c.end - c.start);
  // 把最后一条起点拖到 4（与第2条重叠 1s，第2条左推至 [2,4]，第1条恰好不受影响）
  const next = applyEdit(cues, 'start', 2, 4, true);
  expectValid(next);
  assert.equal(next[2].start, 4);
  assert.equal(next[2].end, 7);
  assert.equal(next[1].start, 2);
  assert.equal(next[1].end, 4);
  assert.equal(next[0].start, 0);
  assert.equal(next[0].end, 2);
  // 邻居时长保持
  assert(Math.abs(next[1].end - next[1].start - durations[1]) < 1e-9);
  assert(Math.abs(next[0].end - next[0].start - durations[0]) < 1e-9);
});

test('连锁左推空间不足时在 0 处回夹，仍满足全部不变量', () => {
  const cues = mkCues([
    [0, 1.5],
    [2.5, 4],
    [5, 6],
  ]);
  // 把最后一条起点拖到 1 → 它变成 [1,6]，左侧空间不足
  const next = applyEdit(cues, 'start', 2, 1, true);
  expectValid(next);
  // 最终只能依次排开：[0,1.5] [1.5,3] [3,8]
  assert.equal(next[0].start, 0);
  assert.equal(next[0].end, 1.5);
  assert.equal(next[1].start, 1.5);
  assert.equal(next[1].end, 3);
  assert.equal(next[2].start, 3);
  assert.equal(next[2].end, 8);
});

test('连锁整体移动跨过多条字幕，全部波纹推开', () => {
  const cues = mkCues([
    [0, 0.5],
    [1, 1.5],
    [2, 2.5],
    [3, 3.5],
  ]);
  const next = applyEdit(cues, 'move', 0, 2.2, true);
  expectValid(next);
  // 顺序可能重排，但所有条互不重叠
  const sorted = [...next].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length - 1; i++) {
    assert(sorted[i].end <= sorted[i + 1].start + 1e-9);
  }
});

test('连锁模式密集字幕压缩后每条仍至少 300ms', () => {
  // 4 条紧密排列，把第一条的终点拖到很后面，空间充足；反向极端用例：
  // 多条 300ms 的字幕，左推到 0 附近
  const cues = mkCues([
    [0, 0.3],
    [0.3, 0.6],
    [0.6, 0.9],
    [0.9, 1.2],
  ]);
  const next = applyEdit(cues, 'move', 3, -10, true);
  expectValid(next);
  next.forEach((c) => assert(c.start >= -1e-9));
  next.forEach((c) => assert(c.end - c.start >= MIN_DURATION - 1e-6));
});

test('大量连锁压力测试：随机拖拽始终满足不变量', () => {
  let cues: Cue[] = [];
  for (let i = 0; i < 30; i++) {
    cues.push({ id: `c${i}`, start: i * 1.1, end: i * 1.1 + 0.8, text: `${i}` });
  }
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let n = 0; n < 500; n++) {
    const idx = Math.floor(rand() * cues.length);
    const kind = (['move', 'start', 'end'] as const)[Math.floor(rand() * 3)];
    const value = rand() * 25 - 5;
    cues = applyEdit(cues, kind, idx, value, true);
    if (n % 10 === 0) expectValid(cues);
  }
  expectValid(cues);
});

// ---------- 吸附 ----------
test('100ms 内吸附到相邻边界', () => {
  const cues = mkCues([
    [0, 1],
    [2, 3],
  ]);
  // 移动第一条，终点距第二条起点 0.06s → 应吸附
  const r = computeSnap(cues, 0, 'move', 0.94, 1.94, null);
  assert.equal(r.snapTime, 2);
  assert.equal(r.end, 2);
});

test('超过 100ms 不吸附', () => {
  const cues = mkCues([
    [0, 1],
    [2, 3],
  ]);
  const r = computeSnap(cues, 0, 'move', 0.85, 1.85, null);
  assert.equal(r.snapTime, null);
});

test('优先吸附更近的目标（播放头 vs 边界）', () => {
  const cues = mkCues([
    [0, 1],
    [2, 3],
  ]);
  // 起点 0.05 接近播放头 0，同时终点 1.94 接近 2（差 0.06）→ 取更近的播放头
  const r = computeSnap(cues, 0, 'move', 0.05, 1.05, 0);
  assert.equal(r.snapTime, 0);
  assert.equal(r.start, 0);
});

test('吸附阈值常量确为 100ms', () => {
  assert.equal(SNAP_DISTANCE, 0.1);
});

// ---------- VTT 解析/序列化 ----------
test('解析带 id、NOTE、设置行的 VTT', () => {
  const vtt = `WEBVTT

NOTE This is a note

cue-1
00:00:01.500 --> 00:00:03.200 align:start
第一条

00:00:04,000 --> 00:05.500
第二条，逗号毫秒
多行`;
  const cues = parseVtt(vtt);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].id, 'cue-1');
  assert.equal(cues[0].start, 1.5);
  assert.equal(cues[0].end, 3.2);
  assert.equal(cues[0].text, '第一条');
  assert.equal(cues[1].start, 4);
  assert.equal(cues[1].text, '第二条，逗号毫秒\n多行');
});

test('非法输入返回空数组而不抛错', () => {
  assert.deepEqual(parseVtt('hello world'), []);
  assert.deepEqual(parseVtt(''), []);
});

test('忽略时长不足 300ms 的坏数据行', () => {
  const cues = parseVtt(`WEBVTT

00:00:01.000 --> 00:00:01.100
太短
00:00:02.000 --> 00:00:03.000
正常`);
  assert.equal(cues.length, 1);
});

test('序列化后可往返解析且时间一致', () => {
  const cues = mkCues([
    [0.5, 3],
    [3.2, 6],
  ]);
  const text = serializeVtt(cues);
  const reparsed = parseVtt(text);
  assert.equal(reparsed.length, 2);
  assert(Math.abs(reparsed[0].start - 0.5) < 1e-9);
  assert(Math.abs(reparsed[1].end - 6) < 1e-9);
  assert(text.startsWith('WEBVTT'));
});

test('时间戳解析/格式化', () => {
  assert.equal(parseTimestamp('00:00:01.500'), 1.5);
  assert.equal(parseTimestamp('00:01.500'), 1.5);
  assert.equal(parseTimestamp('01:02:03.004'), 3723.004);
  assert.equal(parseTimestamp('bad'), null);
  assert.equal(formatTimestamp(3723.004), '01:02:03.004');
});

// ---------- 剪辑版本时间映射 ----------
test('锚点校验：少于两组或任一侧非严格递增都被拒绝', () => {
  assert(validateAnchors([]) !== null);
  assert(validateAnchors([{ oldTime: 1, newTime: 1 }]) !== null);
  // 旧版时间不递增
  assert(validateAnchors([
    { oldTime: 1, newTime: 1 },
    { oldTime: 1, newTime: 2 },
  ]) !== null);
  assert(validateAnchors([
    { oldTime: 2, newTime: 1 },
    { oldTime: 1, newTime: 2 },
  ]) !== null);
  // 新版时间不递增
  assert(validateAnchors([
    { oldTime: 1, newTime: 2 },
    { oldTime: 2, newTime: 2 },
  ]) !== null);
  // 合法
  assert(validateAnchors([
    { oldTime: 1, newTime: 1 },
    { oldTime: 2, newTime: 2 },
  ]) === null);
});

test('分段线性映射：锚点精确命中，段内线性插值', () => {
  const anchors = [
    { oldTime: 10, newTime: 20 },
    { oldTime: 20, newTime: 40 },
    { oldTime: 40, newTime: 50 },
  ];
  assert.equal(mapTime(anchors, 10), 20);
  assert.equal(mapTime(anchors, 20), 40);
  assert.equal(mapTime(anchors, 40), 50);
  assert.equal(mapTime(anchors, 15), 30); // 第一段斜率 2
  assert.equal(mapTime(anchors, 30), 45); // 第二段斜率 0.5
});

test('区间外按最近一段斜率外推', () => {
  const anchors = [
    { oldTime: 10, newTime: 20 },
    { oldTime: 20, newTime: 40 },
    { oldTime: 40, newTime: 50 },
  ];
  assert.equal(mapTime(anchors, 0), 0); // 首段斜率 2 向左外推
  assert.equal(mapTime(anchors, 5), 10);
  assert.equal(mapTime(anchors, 50), 55); // 末段斜率 0.5 向右外推
});

test('预览标出负起点 / 时长不足 300ms / 相邻重叠，且禁止应用', () => {
  const cues = mkCues([
    [0, 1],
    [2, 3],
    [4, 5],
  ]);
  // 斜率 0.1：1s 时长被压成 0.1s → 时长不足
  const compressed = previewRemap(cues, [
    { oldTime: 0, newTime: 10 },
    { oldTime: 10, newTime: 11 },
  ]);
  assert(!compressed.ok);
  assert(compressed.issues.every((i) => i.kind === 'short-duration'));
  assert(compressed.rows.every((r) => r.issues.includes('short-duration')));

  // 首段外推到负区间 → 负起点
  const negative = previewRemap(mkCues([[0, 1]]), [
    { oldTime: 10, newTime: 0 },
    { oldTime: 20, newTime: 10 },
  ]);
  assert(!negative.ok);
  assert(negative.issues.some((i) => i.kind === 'negative-start'));

  // 输入本身重叠（恒等映射）→ 重叠的两条都被标出
  const overlapping = previewRemap(
    mkCues([
      [0, 2],
      [1, 3],
    ]),
    [
      { oldTime: 0, newTime: 0 },
      { oldTime: 10, newTime: 10 },
    ],
  );
  assert(!overlapping.ok);
  assert(overlapping.rows[0].issues.includes('overlap'));
  assert(overlapping.rows[1].issues.includes('overlap'));

  // 预览未通过时 applyRemap 原样返回（不产生新数组）
  assert.equal(applyRemap(cues, [
    { oldTime: 0, newTime: 10 },
    { oldTime: 10, newTime: 11 },
  ]), cues);
});

test('应用映射：一次性替换时间，保留 id 与文本，结果满足不变量', () => {
  const cues = mkCues([
    [0, 1],
    [2, 4],
  ]);
  const anchors = [
    { oldTime: 0, newTime: 5 },
    { oldTime: 4, newTime: 9 },
  ];
  const next = applyRemap(cues, anchors);
  assert.equal(next.length, 2);
  // id / 文本保留
  assert.equal(next[0].id, cues[0].id);
  assert.equal(next[0].text, cues[0].text);
  assert.equal(next[1].id, cues[1].id);
  // 时间被替换：斜率 1，整体平移 +5
  assert.equal(next[0].start, 5);
  assert.equal(next[0].end, 6);
  assert.equal(next[1].start, 7);
  assert.equal(next[1].end, 9);
  expectValid(next);
  // 原数组未被修改
  assert.equal(cues[0].start, 0);
});

test('映射结果可序列化往返', () => {
  const cues = mkCues([
    [1, 2.5],
    [3, 4],
  ]);
  const next = applyRemap(cues, [
    { oldTime: 0, newTime: 2 },
    { oldTime: 10, newTime: 20 },
  ]);
  const reparsed = parseVtt(serializeVtt(next));
  assert.equal(reparsed.length, 2);
  assert(Math.abs(reparsed[0].start - next[0].start) < 1e-3);
  assert(Math.abs(reparsed[1].end - next[1].end) < 1e-3);
});

// ---------- 术语审校 ----------
function mkRules(...pairs: Array<[string, string]>): TermRule[] {
  return pairs.map(([source, target], i) => ({ id: `r${i}`, source, target }));
}

test('规则校验：整行留空忽略，只填一半或原词重复被拒绝', () => {
  // 全空行被忽略 → 合法
  assert.equal(validateRules(mkRules(['', ''])), null);
  assert.equal(validateRules(mkRules(['  ', ' '])), null);
  // 只填一半 → 报错
  assert(validateRules(mkRules(['hello', ''])) !== null);
  assert(validateRules(mkRules(['', 'hi'])) !== null);
  assert(validateRules(mkRules(['  ', 'hi'])) !== null);
  // 原词重复 → 报错
  assert(validateRules(mkRules(['a', 'x'], ['a', 'y'])) !== null);
  // 合法
  assert(validateRules(mkRules(['a', 'x'], ['ab', 'y'])) === null);
  // effectiveRules 只保留完整行
  const eff = effectiveRules(mkRules(['a', 'x'], ['', ''], ['b', '']));
  assert.equal(eff.length, 1);
  assert.equal(eff[0].source, 'a');
});

test('术语替换：区分大小写的字面匹配', () => {
  const r = replaceTerms('Hello hello HELLO', mkRules(['hello', '嗨']));
  assert.equal(r.newText, 'Hello 嗨 HELLO');
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].start, 6);
  assert.equal(r.hits[0].end, 11);
});

test('术语替换：内联标签作为边界且原样保留', () => {
  // 标签内的可见文本仍可匹配，标签本身原样保留
  const r = replaceTerms('<b>hello</b> <i class="x">hello</i>', mkRules(['hello', 'hi']));
  assert.equal(r.newText, '<b>hi</b> <i class="x">hi</i>');
  assert.equal(r.hits.length, 2);
  // 匹配不可跨越标签边界
  const cross = replaceTerms('he<b>llo</b>', mkRules(['hello', 'X']));
  assert.equal(cross.newText, 'he<b>llo</b>');
  assert.equal(cross.hits.length, 0);
  // 时间戳标签与 voice 标签同样是边界
  const ts = replaceTerms('<00:00:01.000>hello<v Speaker>world</v>', mkRules(['hello', 'H'], ['world', 'W']));
  assert.equal(ts.newText, '<00:00:01.000>H<v Speaker>W</v>');
});

test('术语替换：实体作为边界且原样保留', () => {
  // &amp; 是边界：ab 不能跨越它匹配；实体内容不参与匹配
  const r = replaceTerms('a&amp;b', mkRules(['ab', 'X'], ['amp', 'Y'], ['a', '1'], ['b', '2']));
  assert.equal(r.newText, '1&amp;2');
  assert.equal(r.hits.length, 2);
  // 数字实体与未知命名实体同样视为边界
  const num = replaceTerms('x&#65;y&foo;z', mkRules(['xy', 'X'], ['xyz', 'X'], ['foo', 'F']));
  assert.equal(num.newText, 'x&#65;y&foo;z');
  // 裸露的 & 不是实体，仍属可见文本
  const bare = replaceTerms('a & b', mkRules(['&', '和']));
  assert.equal(bare.newText, 'a 和 b');
});

test('术语替换：同一位置取最长原词，等长按规则顺序', () => {
  // 最长优先
  const r = replaceTerms('hello world', mkRules(['he', 'X'], ['hello', 'Y'], ['hell', 'Z']));
  assert.equal(r.newText, 'Y world');
  assert.equal(r.hits[0].source, 'hello');
  // 等长（同词）按规则顺序，靠前者优先
  const tie = replaceTerms('ab', mkRules(['ab', '第一'], ['ab', '第二']));
  assert.equal(tie.newText, '第一');
});

test('术语替换：已选中的字符不再重复匹配', () => {
  // "aa" 在 "aaa" 上只命中一次（0–2），余下的 a 保留
  const r = replaceTerms('aaa', mkRules(['aa', 'X']));
  assert.equal(r.newText, 'Xa');
  assert.equal(r.hits.length, 1);
  // ab 消费后，bc 无法在位置 1 命中
  const overlap = replaceTerms('abc', mkRules(['ab', 'X'], ['bc', 'Y']));
  assert.equal(overlap.newText, 'Xc');
  // 替换结果不会被二次扫描：target 含 source 也不递归
  const noRecurse = replaceTerms('a', mkRules(['a', 'aa']));
  assert.equal(noRecurse.newText, 'aa');
  assert.equal(noRecurse.hits.length, 1);
});

test('术语替换：命中区间与替换后区间一一对应', () => {
  const r = replaceTerms('foo bar foo', mkRules(['foo', 'F'], ['bar', 'BB']));
  assert.equal(r.newText, 'F BB F');
  assert.deepEqual(
    r.hits.map((h) => [h.start, h.end]),
    [
      [0, 3],
      [4, 7],
      [8, 11],
    ],
  );
  assert.deepEqual(
    r.newRanges.map((g) => r.newText.slice(g.start, g.end)),
    ['F', 'BB', 'F'],
  );
  // 空规则表 → 原样返回
  const noop = replaceTerms('hello', []);
  assert.equal(noop.newText, 'hello');
  assert.equal(noop.hits.length, 0);
});

test('术语预览：只列出有命中的字幕，按时间轴顺序', () => {
  const cues: Cue[] = [
    { id: 'c1', start: 5, end: 6, text: 'nothing here' },
    { id: 'c2', start: 1, end: 2, text: 'say hello' },
    { id: 'c3', start: 3, end: 4, text: 'hello again' },
  ];
  const rows = previewTerms(cues, mkRules(['hello', 'hi']));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].cue.id, 'c2'); // 按起点排序
  assert.equal(rows[1].cue.id, 'c3');
  assert.equal(rows[0].newText, 'say hi');
  assert.equal(rows[1].hits.length, 1);
  // 无有效规则 → 无预览行
  assert.equal(previewTerms(cues, mkRules(['', ''])).length, 0);
});

test('术语应用：仅替换所选字幕文本，时间与 id 不变', () => {
  const cues: Cue[] = [
    { id: 'c1', start: 0, end: 1, text: 'hello one' },
    { id: 'c2', start: 2, end: 3, text: 'hello two' },
    { id: 'c3', start: 4, end: 5, text: 'no match' },
  ];
  const rules = mkRules(['hello', 'hi']);
  // 只勾选 c1 与 c3（c3 无命中）
  const next = applyTerms(cues, rules, new Set(['c1', 'c3']));
  assert.equal(next[0].text, 'hi one');
  assert.equal(next[1].text, 'hello two'); // 未勾选 → 不变
  assert.equal(next[2].text, 'no match');
  // 时间与 id 不变
  next.forEach((c, i) => {
    assert.equal(c.id, cues[i].id);
    assert.equal(c.start, cues[i].start);
    assert.equal(c.end, cues[i].end);
  });
  // 未改动的行保持对象引用（最小化 diff）
  assert.equal(next[1], cues[1]);
  assert.equal(next[2], cues[2]);
  // 原数组未被修改
  assert.equal(cues[0].text, 'hello one');
});

test('术语应用：空选择或无命中时原样返回（不产生撤销记录）', () => {
  const cues: Cue[] = [{ id: 'c1', start: 0, end: 1, text: 'hello' }];
  const rules = mkRules(['hello', 'hi']);
  assert.equal(applyTerms(cues, rules, new Set()), cues);
  assert.equal(applyTerms(cues, rules, new Set(['nope'])), cues);
  assert.equal(applyTerms(cues, mkRules(['zzz', 'q']), new Set(['c1'])), cues);
  assert.equal(applyTerms(cues, mkRules(['', '']), new Set(['c1'])), cues);
});

test('术语替换结果可序列化往返，导出反映替换', () => {
  const cues = parseVtt(`WEBVTT

cue-1
00:00:01.000 --> 00:00:03.000
<b>帐号</b> 与 &amp; 实体

cue-2
00:00:04.000 --> 00:00:06.000
帐号 再见`);
  const next = applyTerms(cues, mkRules(['帐号', '账号']), new Set(['cue-1', 'cue-2']));
  assert.equal(next[0].text, '<b>账号</b> 与 &amp; 实体');
  assert.equal(next[1].text, '账号 再见');
  const text = serializeVtt(next);
  assert(text.includes('<b>账号</b> 与 &amp; 实体'));
  assert(text.includes('账号 再见'));
  const reparsed = parseVtt(text);
  assert.equal(reparsed.length, 2);
  assert.equal(reparsed[0].id, 'cue-1');
  assert.equal(reparsed[0].text, '<b>账号</b> 与 &amp; 实体');
  assert(Math.abs(reparsed[0].start - 1) < 1e-9);
});

// ---------- 字幕拆分 ----------
test('拆分计数：码点、换行、实体各计 1，标签不计', () => {
  // 纯文本按码点计（代理对只算 1 字）
  const a1 = analyzeCueText('ab👋c');
  assert(a1.ok && a1.total === 4);
  // 换行计 1 字
  const a2 = analyzeCueText('ab\ncd');
  assert(a2.ok && a2.total === 5);
  // 命名/十进制/十六进制实体各计 1
  const a3 = analyzeCueText('a&amp;b&#65;c&#x41;');
  assert(a3.ok && a3.total === 6);
  // 标签不计字数
  const a4 = analyzeCueText('<b>hello</b> <i class="x">w</i>');
  assert(a4.ok && a4.total === 7);
  // 空文本 / 只有标签
  const a5 = analyzeCueText('');
  assert(a5.ok && a5.total === 0);
  const a6 = analyzeCueText('<b></b>');
  assert(a6.ok && a6.total === 0);
});

test('拆分校验：未知/不配对/未闭合标签与内联时间戳均报错', () => {
  assert(!analyzeCueText('<ruby>字</ruby>').ok); // 未知标签
  assert(!analyzeCueText('<foo>x</foo>').ok); // 未知标签
  assert(!analyzeCueText('a</b>').ok); // 闭标签无对应开标签
  assert(!analyzeCueText('<b>abc').ok); // 未闭合
  assert(!analyzeCueText('<b><i>x</b></i>').ok); // 嵌套错误
  assert(!analyzeCueText('a<00:00:01.000>b').ok); // 内联时间戳
  assert(!analyzeCueText('a<1:02.500>b').ok); // 内联时间戳（短格式）
  // 合法的 b/i/u/c/v/lang（含 class 与注解）
  const ok = analyzeCueText('<b>a</b><i>b</i><u>c</u><c.foo>d</c><v 甲>e</v><lang en>f</lang>');
  assert(ok.ok && ok.total === 6);
  // 大小写不敏感
  const upper = analyzeCueText('<B>a</B>');
  assert(upper.ok && upper.total === 1);
});

test('拆分预览：纯文本两段正文与时间正确，时间四舍五入到毫秒', () => {
  const cue: Cue = { id: 'c1', start: 1, end: 4, text: 'abcdef' }; // 6 字 / 3s
  const r = previewSplit(cue, 2);
  assert(r.ok);
  assert.equal(r.preview.leftText, 'ab');
  assert.equal(r.preview.rightText, 'cdef');
  assert.equal(r.preview.total, 6);
  assert.equal(r.preview.leftCount, 2);
  assert.equal(r.preview.rightCount, 4);
  // 分割时间 = 1 + 3 × 2/6 = 2
  assert.equal(r.preview.splitTime, 2);
  assert.equal(r.preview.leftStart, 1);
  assert.equal(r.preview.leftEnd, 2);
  assert.equal(r.preview.rightStart, 2);
  assert.equal(r.preview.rightEnd, 4);
  // 毫秒四舍五入：7 字 / 2s，N=2 → 1 + 4/7 ≈ 1.571428 → 1.571
  const cue2: Cue = { id: 'c2', start: 1, end: 3, text: 'abcdefg' };
  const r2 = previewSplit(cue2, 2);
  assert(r2.ok);
  assert.equal(r2.preview.splitTime, 1.571);
});

test('拆分预览：切点处标签按嵌套逆序闭合左段、原样重开右段', () => {
  const cue: Cue = { id: 'c1', start: 0, end: 6, text: '<b>x<i>ab</i>y</b>z' }; // 可见 x a b y z
  const r = previewSplit(cue, 2); // 切在 a 之后，<b> 与 <i> 均开放
  assert(r.ok);
  assert.equal(r.preview.leftText, '<b>x<i>a</i></b>');
  assert.equal(r.preview.rightText, '<b><i>b</i>y</b>z');
});

test('拆分预览：紧跟切点的闭合标签并入左段，不产生空标签对', () => {
  const cue: Cue = { id: 'c1', start: 0, end: 5, text: '<i>ab</i>cd' };
  const r = previewSplit(cue, 2);
  assert(r.ok);
  assert.equal(r.preview.leftText, '<i>ab</i>');
  assert.equal(r.preview.rightText, 'cd');
  // 多层嵌套同样吸收
  const cue2: Cue = { id: 'c2', start: 0, end: 5, text: '<b><i>ab</i></b>cd' };
  const r2 = previewSplit(cue2, 2);
  assert(r2.ok);
  assert.equal(r2.preview.leftText, '<b><i>ab</i></b>');
  assert.equal(r2.preview.rightText, 'cd');
  // 大小写混合：自动闭合/重开保留开标签原文；</I> 紧跟切点被左段吸收，右段只重开 <B>
  const cue3: Cue = { id: 'c3', start: 0, end: 5, text: '<B>a<I>b</I>c</B>d' };
  const r3 = previewSplit(cue3, 2);
  assert(r3.ok);
  assert.equal(r3.preview.leftText, '<B>a<I>b</I></B>');
  assert.equal(r3.preview.rightText, '<B>c</B>d');
});

test('拆分预览：实体与换行参与计数且原样保留', () => {
  const cue: Cue = { id: 'c1', start: 0, end: 5, text: 'a&amp;b\nc&#65;d' }; // 可见 7 字
  const r = previewSplit(cue, 2); // 切在 &amp; 之后
  assert(r.ok);
  assert.equal(r.preview.leftText, 'a&amp;');
  assert.equal(r.preview.rightText, 'b\nc&#65;d');
  const r2 = previewSplit(cue, 4); // 切在换行之后
  assert(r2.ok);
  assert.equal(r2.preview.leftText, 'a&amp;b\n');
  assert.equal(r2.preview.rightText, 'c&#65;d');
});

test('拆分预览：切点须为整数且两段非空', () => {
  const cue: Cue = { id: 'c1', start: 0, end: 5, text: 'abcdef' };
  assert(!previewSplit(cue, 0).ok); // 左段空
  assert(!previewSplit(cue, 6).ok); // 右段空
  assert(!previewSplit(cue, 2.5).ok); // 非整数
  assert(!previewSplit(cue, -1).ok);
  assert(!previewSplit(cue, NaN).ok);
  // 可见字数不足 2
  assert(!previewSplit({ id: 'c2', start: 0, end: 5, text: '<b>a</b>' }, 1).ok);
  assert(!previewSplit({ id: 'c3', start: 0, end: 5, text: '' }, 1).ok);
});

test('拆分预览：任一段不足 300ms 禁止应用', () => {
  // 10 字 / 1s：N=3 → 左段恰 300ms 允许；N=2 → 200ms 禁止
  const cue: Cue = { id: 'c1', start: 0, end: 1, text: '0123456789' };
  assert(previewSplit(cue, 3).ok);
  assert(!previewSplit(cue, 2).ok);
  // 右段不足 300ms：N=8 → 右段 200ms
  assert(!previewSplit(cue, 8).ok);
  assert(previewSplit(cue, 7).ok);
});

test('拆分应用：两条新 id 字幕替换原条，首尾相接保留原起止', () => {
  const cue: Cue = { id: 'orig', start: 1.5, end: 4.5, text: '<b>hello</b> world', note: 'n' };
  let seq = 0;
  const parts = splitCue(cue, 5, () => `new-${++seq}`);
  assert(parts !== null);
  assert.equal(parts.length, 2);
  // 新 id 且互不相同、不等于原 id
  assert.equal(parts[0].id, 'new-1');
  assert.equal(parts[1].id, 'new-2');
  // 首尾相接、保留原起止
  assert.equal(parts[0].start, 1.5);
  assert.equal(parts[0].end, parts[1].start);
  assert.equal(parts[1].end, 4.5);
  // 文本正确拆分（标签闭合/重开）
  assert.equal(parts[0].text, '<b>hello</b>');
  assert.equal(parts[1].text, ' world');
  // 其余字段保留
  assert.equal(parts[0].note, 'n');
  assert.equal(parts[1].note, 'n');
  // 非法切点返回 null
  assert.equal(splitCue(cue, 0, () => 'x'), null);
  assert.equal(splitCue({ id: 'c', start: 0, end: 1, text: 'a<foo>b' }, 1, () => 'x'), null);
});

test('拆分结果满足不变量且可序列化往返', () => {
  const cues: Cue[] = [
    { id: 'c1', start: 0.5, end: 2, text: '前一条' },
    { id: 'c2', start: 2, end: 6, text: '<v 甲>第一行\n第二行</v> 尾' },
    { id: 'c3', start: 6.5, end: 8, text: '后一条' },
  ];
  const parts = splitCue(cues[1], 4, () => `p${Math.random()}`);
  assert(parts !== null);
  const next = [cues[0], ...parts, cues[2]];
  expectValid(next);
  // 相邻关系：左段接前一条，右段接后一条
  assert(next[0].end <= next[1].start + 1e-9);
  assert(next[2].end <= next[3].start + 1e-9);
  // 序列化往返保持拆分结果
  const reparsed = parseVtt(serializeVtt(next));
  assert.equal(reparsed.length, 4);
  assert.equal(reparsed[1].text, parts[0].text);
  assert.equal(reparsed[2].text, parts[1].text);
  assert(Math.abs(reparsed[1].end - parts[0].end) < 1e-3);
  assert(Math.abs(reparsed[2].start - parts[1].start) < 1e-3);
});

// ---------- 字幕自动换行：显示宽度 ----------
test('显示宽度：ASCII 计 1 列，CJK/全角/表情计 2 列，组合符/格式符计 0 列', () => {
  assert.equal(charDisplayWidth('a'.codePointAt(0)!), 1);
  assert.equal(charDisplayWidth('中'.codePointAt(0)!), 2); // CJK
  assert.equal(charDisplayWidth('　'.codePointAt(0)!), 2); // 全角空格 U+3000
  assert.equal(charDisplayWidth('，'.codePointAt(0)!), 2); // 全角逗号
  assert.equal(charDisplayWidth('Ａ'.codePointAt(0)!), 2); // 全角拉丁
  assert.equal(charDisplayWidth('😀'.codePointAt(0)!), 2); // 表情（代理对）
  assert.equal(charDisplayWidth('가'.codePointAt(0)!), 2); // 谚文音节
  // 组合符与变体选择符计 0
  assert.equal(charDisplayWidth(0x0301), 0); // combining acute
  assert.equal(charDisplayWidth(0xfe0f), 0); // VS16（Cf）
  assert.equal(charDisplayWidth(0x200d), 0); // ZWJ
  // 普通空格计 1
  assert.equal(charDisplayWidth(0x20), 1);
});

test('实体作为一个可见字符按所代表字符计列，未知名称与非法码点按 1 列', () => {
  assert.equal(entityDisplayWidth('&amp;'), 1); // &
  assert.equal(entityDisplayWidth('&lt;'), 1);
  assert.equal(entityDisplayWidth('&#x4E2D;'), 2); // 中
  assert.equal(entityDisplayWidth('&#65;'), 1); // A
  assert.equal(entityDisplayWidth('&#x1F600;'), 2); // 😀
  assert.equal(entityDisplayWidth('&unknown;'), 1); // 未知名称
  assert.equal(entityDisplayWidth('&#99999999;'), 1); // 越界码点
});

test('analyzeWrap：已有换行的字幕不自动改写', () => {
  const a = analyzeWrap({ id: 'c', start: 0, end: 2, text: '第一行\n第二行' });
  assert(!a.ok && a.error.includes('已有换行'));
  const b = analyzeWrap({ id: 'c', start: 0, end: 2, text: 'a\rb' });
  assert(!b.ok && b.error.includes('已有换行'));
  // 单行正常
  const ok = analyzeWrap({ id: 'c', start: 0, end: 2, text: 'abc 中' });
  assert(ok.ok && ok.totalWidth === 6 && ok.visible === 5);
  // 标签非法时报错（复用拆分校验）
  const bad = analyzeWrap({ id: 'c', start: 0, end: 2, text: 'a<00:00:01.000>b' });
  assert(!bad.ok && bad.error.includes('内联时间戳'));
});

// ---------- 字幕自动换行：断点选择 ----------
test('空格断点：空白被替换为换行，标签不计列且原样保留', () => {
  // 标签 <b></b> 不计列；可见 "abcd ef gh" = 10 列
  const cue: Cue = { id: 'c1', start: 0, end: 5, text: '<b>abcd</b> ef gh' };
  // max 5：断点1（abcd 后）4/5 可行；断点2（ef 后）7/2 左超 → 唯一选断点1
  const r = previewWrap(cue, 5);
  assert(r.ok);
  assert.equal(r.preview.line1, '<b>abcd</b>');
  assert.equal(r.preview.line2, 'ef gh');
  assert.equal(r.preview.line1Width, 4);
  assert.equal(r.preview.line2Width, 5);
  assert.equal(r.preview.kind, 'space');
  assert.equal(r.preview.newText, '<b>abcd</b>\nef gh');
});

test('连续空格合并为一个断点，换行时整段空白被替换', () => {
  const cue: Cue = { id: 'c1', start: 0, end: 5, text: 'ab    cd' }; // 4 个空格
  const r = previewWrap(cue, 4);
  assert(r.ok);
  assert.equal(r.preview.line1, 'ab');
  assert.equal(r.preview.line2, 'cd');
  assert.equal(r.preview.newText, 'ab\ncd');
  // 原空白不出现在结果里
  assert(!r.preview.newText.includes(' '));
});

test('标点断点：换行插在连续标点之后，标点留在第一行末尾', () => {
  const cue: Cue = { id: 'c1', start: 0, end: 5, text: '你好，世界！再见' };
  // 宽字符：每字 2 列；总 16 列。max 10
  // 逗号断：左 6（你好，），右 10（世界！再见）→ max 10 可行
  // 叹号断：左 12（你好，世界！），右 4（再见）→ 左超，不可行
  const r = previewWrap(cue, 10);
  assert(r.ok);
  assert.equal(r.preview.line1, '你好，');
  assert.equal(r.preview.line2, '世界！再见');
  assert.equal(r.preview.line1Width, 6);
  assert.equal(r.preview.line2Width, 10);
  assert.equal(r.preview.kind, 'punct');
  // max 6：逗号断 6/10 右超、叹号断 12/4 左超 → 无满足断点
  const none = previewWrap(cue, 6);
  assert(!none.ok && none.error.includes('找不到满足上限'));
});

test('选点规则：最长宽度最小优先，再宽度差最小，并列取最靠前', () => {
  // "aaaa bbbb cc"：空格1 在 4 后（左4右7），空格2 在 9 后（左9右2）
  const cue: Cue = { id: 'c', start: 0, end: 5, text: 'aaaa bbbb cc' };
  // max 9：两断点都可行 → max(4,7)=7 vs max(9,2)=9 → 选空格1
  const r = previewWrap(cue, 9);
  assert(r.ok);
  assert.equal(r.preview.line1, 'aaaa');
  assert.equal(r.preview.line2, 'bbbb cc');
});

test('最长宽度相同时取宽度差更小者（更均衡）', () => {
  // "ab,c de"：标点断 3/4（max4,差1），空格断 4/2（max4,差2）→ 同 max，取差小的标点断
  const cue: Cue = { id: 'c', start: 0, end: 5, text: 'ab,c de' };
  const r = previewWrap(cue, 4);
  assert(r.ok);
  assert.equal(r.preview.kind, 'punct');
  assert.equal(r.preview.line1, 'ab,');
  assert.equal(r.preview.line2, 'c de');
  assert.equal(r.preview.line1Width, 3);
  assert.equal(r.preview.line2Width, 4);
  assert.equal(r.preview.feasibleCount, 2);
});

test('并列时位置最靠前保证唯一断点', () => {
  // "ab cd ef"：断点1 2/5（max5,差3），断点2 5/2（max5,差3）→ 完全并列 → 靠前
  const cue: Cue = { id: 'c', start: 0, end: 5, text: 'ab cd ef' };
  const r = previewWrap(cue, 6);
  assert(r.ok);
  assert.equal(r.preview.line1, 'ab');
  assert.equal(r.preview.line2, 'cd ef');
  assert.equal(r.preview.feasibleCount, 2);
});

test('宽字符按 2 列计：CJK 句子的断点与上限', () => {
  // "你好 世界"：左4 右4；总 8 列
  const cue: Cue = { id: 'c', start: 0, end: 5, text: '你好 世界' };
  const r = previewWrap(cue, 4);
  assert(r.ok);
  assert.equal(r.preview.line1, '你好');
  assert.equal(r.preview.line2, '世界');
  assert.equal(r.preview.line1Width, 4);
  // max 3：4/4 均超 → 无满足断点
  assert(!previewWrap(cue, 3).ok);
});

test('实体参与计列但不作为断点，原样保留', () => {
  // "a&amp;b cd"：&amp; 计 1（实体非空格非标点）→ "a&b cd" = 6 列
  const cue: Cue = { id: 'c', start: 0, end: 5, text: 'a&amp;b cd' };
  const r = previewWrap(cue, 4);
  assert(r.ok);
  assert.equal(r.preview.line1, 'a&amp;b');
  assert.equal(r.preview.line2, 'cd');
  assert.equal(r.preview.newText, 'a&amp;b\ncd');
  // 宽实体：&#x4E2D;（中，2 列）
  const cue2: Cue = { id: 'c2', start: 0, end: 5, text: 'x&#x4E2D;y ab' };
  const r2 = previewWrap(cue2, 4); // 左 4（x中y），右 2
  assert(r2.ok);
  assert.equal(r2.preview.line1, 'x&#x4E2D;y');
  assert.equal(r2.preview.line2Width, 2);
});

test('组合符（零宽）不计列但保留在正文', () => {
  // e + 组合符 U+0301（0 列）→ "é" 整体计 1 列
  const cue: Cue = { id: 'c', start: 0, end: 5, text: 'e\u0301f gh' };
  const r = previewWrap(cue, 3);
  assert(r.ok);
  assert.equal(r.preview.line1, 'e\u0301f');
  assert.equal(r.preview.line1Width, 2);
  assert.equal(r.preview.line2, 'gh');
});

test('无空格/标点边界时禁止换行', () => {
  const cue: Cue = { id: 'c', start: 0, end: 5, text: 'abcdefghij' };
  const r = previewWrap(cue, 5);
  assert(!r.ok && r.error.includes('没有空格或标点边界'));
});

test('首尾空白/标点不产生空行断点', () => {
  // 开头空格不算断点（左段会无可见字符）
  const cue1: Cue = { id: 'c1', start: 0, end: 5, text: ' ab cd' };
  const r1 = previewWrap(cue1, 5);
  assert(r1.ok);
  assert.notEqual(r1.preview.line1, '');
  // 结尾标点后不算断点（右段会无可见字符）
  const cue2: Cue = { id: 'c2', start: 0, end: 5, text: 'ab cd!' };
  const r2 = previewWrap(cue2, 5);
  assert(r2.ok);
  assert.notEqual(r2.preview.line2, '!');
  assert(r2.preview.line2.endsWith('!'));
});

test('全文已不超过上限或无可见字符时不换行', () => {
  const cue: Cue = { id: 'c', start: 0, end: 5, text: 'abc' };
  assert(!previewWrap(cue, 3).ok); // 恰好等于上限
  assert(!previewWrap(cue, 10).ok);
  const empty: Cue = { id: 'c', start: 0, end: 5, text: '<b></b>' };
  assert(!previewWrap(empty, 5).ok);
});

test('非法列数被拒绝', () => {
  const cue: Cue = { id: 'c', start: 0, end: 5, text: 'ab cd ef' };
  assert(!previewWrap(cue, 0).ok);
  assert(!previewWrap(cue, -1).ok);
  assert(!previewWrap(cue, 2.5).ok);
  assert(!previewWrap(cue, NaN).ok);
});

// ---------- 字幕自动换行：应用、撤销、导出 ----------
test('应用换行只改正文，保留 id 与起止时间，其他字幕不变', () => {
  const cue: Cue = { id: 'orig', start: 1.5, end: 4.5, text: 'hello world foo', note: 'n' };
  // 断点1（hello 后）5/9，断点2（world 后）11/3 → max 9 时唯一可行断点1
  const r = wrapCue(cue, 9);
  assert(r !== null);
  assert.equal(r.newText, 'hello\nworld foo');
  // 模拟 App 的提交方式：只替换该条 text
  const next = [{ ...cue, text: r.newText }];
  assert.equal(next[0].id, 'orig');
  assert.equal(next[0].start, 1.5);
  assert.equal(next[0].end, 4.5);
  assert.equal(next[0].note, 'n');
  assert.equal(next[0].text.split('\n').length, 2);
  // 校验失败返回 null
  assert.equal(wrapCue(cue, 1), null);
  assert.equal(wrapCue({ ...cue, text: 'a\nb' }, 5), null); // 已有换行
});

test('换行结果可序列化往返，导出 VTT 保留两行', () => {
  const cues: Cue[] = [
    { id: 'c1', start: 0.5, end: 2, text: '前一条' },
    { id: 'c2', start: 2, end: 6, text: '<b>你好</b> 世界再见' },
    { id: 'c3', start: 6.5, end: 8, text: '后一条' },
  ];
  // c2：标签不计列；可见 你好4 + 空格1 + 世界再见8 = 13 列；空格断 → 4/8
  const r = wrapCue(cues[1], 8);
  assert(r !== null);
  assert.equal(r.newText, '<b>你好</b>\n世界再见');
  const next = cues.map((c) => (c.id === 'c2' ? { ...c, text: r.newText } : c));
  const vtt = serializeVtt(next);
  const reparsed = parseVtt(vtt);
  assert.equal(reparsed.length, 3);
  assert.equal(reparsed[1].id, 'c2');
  assert.equal(reparsed[1].text, r.newText);
  assert(reparsed[1].text.includes('\n'), '导出文本应保留换行');
  assert.equal(reparsed[1].text.split('\n').length, 2);
  assert(Math.abs(reparsed[1].start - 2) < 1e-9);
  assert(Math.abs(reparsed[1].end - 6) < 1e-9);
});

test('已有换行的字幕经 wrapCue 不会被改写（返回 null）', () => {
  const cue: Cue = { id: 'c', start: 0, end: 2, text: '保持原样\n第二行' };
  assert.equal(wrapCue(cue, 5), null);
});

console.log(`\n全部 ${passed} 个测试通过 ✅`);
