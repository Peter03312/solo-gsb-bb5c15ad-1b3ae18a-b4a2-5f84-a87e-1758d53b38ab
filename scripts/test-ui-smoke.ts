import assert from 'node:assert';
import React from 'react';
import { renderToString } from 'react-dom/server';
import TermModal from '../src/components/TermModal';
import SplitModal from '../src/components/SplitModal';
import WrapModal from '../src/components/WrapModal';
import type { Cue } from '../src/types';
import type { TermRule } from '../src/lib/terms';

/** SSR 输出中 React 会在插值处插入 <!-- -->，先归一化再断言 */
function renderTerm(props: Parameters<typeof TermModal>[0]): string {
  return renderToString(React.createElement(TermModal, props)).replace(/<!-- -->/g, '');
}

function renderSplit(props: Parameters<typeof SplitModal>[0]): string {
  return renderToString(React.createElement(SplitModal, props)).replace(/<!-- -->/g, '');
}

function renderWrap(props: Parameters<typeof WrapModal>[0]): string {
  return renderToString(React.createElement(WrapModal, props)).replace(/<!-- -->/g, '');
}

const noop = () => {};

const cues: Cue[] = [
  { id: 'c1', start: 0.5, end: 2, text: '<b>帐号</b> 与 &amp; 实体 hello' },
  { id: 'c2', start: 2.5, end: 4, text: '无命中行' },
  { id: 'c3', start: 4.5, end: 6, text: 'hello hello 帐号' },
];
const rules: TermRule[] = [
  { id: 'r1', source: '帐号', target: '账号' },
  { id: 'r2', source: 'hello', target: '你好' },
  { id: 'r3', source: '', target: '' },
];

// 正常预览渲染：c1 命中 2 处（帐号、hello），c3 命中 3 处（hello×2、帐号）
const html = renderTerm({ cues, rules, onRulesChange: noop, onClose: noop, onApply: noop });
assert(html.includes('术语审校'), '标题缺失');
assert(html.includes('应用替换（2）'), '应默认勾选 2 条命中字幕');
assert(html.includes('帐号→账号'), '命中标签缺失');
assert(html.includes('mark-old') && html.includes('mark-new'), '高亮缺失');
assert(html.includes('&lt;b&gt;'), '标签应按原样转义显示');
assert(html.includes('预览：2 条字幕共 5 处命中，已勾选 2 条。'), '汇总缺失');

// 非法规则（重复原词）→ 显示错误、禁止应用
const bad = renderTerm({
  cues,
  rules: [
    { id: 'r1', source: 'a', target: 'x' },
    { id: 'r2', source: 'a', target: 'y' },
  ],
  onRulesChange: noop,
  onClose: noop,
  onApply: noop,
});
assert(bad.includes('原词重复'), '重复校验缺失');
assert(bad.includes('应用替换（0）'), '无预览时应用数应为 0');

// 空规则 → 提示语
const empty = renderTerm({
  cues,
  rules: [{ id: 'r1', source: '', target: '' }],
  onRulesChange: noop,
  onClose: noop,
  onApply: noop,
});
assert(empty.includes('请先填写至少一条完整规则'), '空规则提示缺失');

// ---------- 拆分弹窗 ----------
// 正常渲染：显示原文、可见字数与时间范围；未输入切点时不显示预览、应用按钮禁用
const splitOk = renderSplit({
  cue: { id: 's1', start: 1, end: 4, text: '<b>hello</b> world' },
  onClose: noop,
  onApply: noop,
});
assert(splitOk.includes('拆分字幕'), '拆分标题缺失');
assert(splitOk.includes('可见 11 字'), '可见字数缺失');
assert(splitOk.includes('00:00:01.000') && splitOk.includes('00:00:04.000'), '时间范围缺失');
assert(splitOk.includes('切点 N'), '切点输入缺失');
assert(!splitOk.includes('split-preview'), '未输入切点不应显示预览');

// 标签非法（内联时间戳）→ 显示错误且输入框禁用
const splitBad = renderSplit({
  cue: { id: 's2', start: 0, end: 2, text: 'a<00:00:01.000>b' },
  onClose: noop,
  onApply: noop,
});
assert(splitBad.includes('内联时间戳'), '内联时间戳错误缺失');

// 标签不配对 → 显示错误
const splitUnpaired = renderSplit({
  cue: { id: 's3', start: 0, end: 2, text: '<b>abc' },
  onClose: noop,
  onApply: noop,
});
assert(splitUnpaired.includes('标签未闭合'), '未闭合错误缺失');

// ---------- 自动换行弹窗 ----------
// 正常渲染：显示原文、总列数与时间范围；未输入列数时不显示预览、应用按钮禁用
const wrapOk = renderWrap({
  cue: { id: 'w1', start: 1, end: 4, text: '<b>你好</b> 世界' },
  onClose: noop,
  onApply: noop,
});
assert(wrapOk.includes('自动换行'), '换行标题缺失');
assert(wrapOk.includes('共 9 列'), '总列数缺失'); // 你好4 + 空格1 + 世界4
assert(wrapOk.includes('00:00:01.000') && wrapOk.includes('00:00:04.000'), '时间范围缺失');
assert(wrapOk.includes('每行最大列数'), '列数输入缺失');
assert(!wrapOk.includes('split-preview'), '未输入列数不应显示预览');

// 已有换行 → 显示原因且输入框禁用
const wrapNl = renderWrap({
  cue: { id: 'w2', start: 0, end: 2, text: '第一行\n第二行' },
  onClose: noop,
  onApply: noop,
});
assert(wrapNl.includes('已有换行'), '已有换行提示缺失');
assert(wrapNl.includes('disabled'), '已有换行时输入框应禁用');

// 标签非法（内联时间戳）→ 显示错误
const wrapBad = renderWrap({
  cue: { id: 'w3', start: 0, end: 2, text: 'a<00:00:01.000>b' },
  onClose: noop,
  onApply: noop,
});
assert(wrapBad.includes('内联时间戳'), '内联时间戳错误缺失');

console.log('UI 冒烟测试通过 ✅');
