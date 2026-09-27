import { useMemo, useState } from 'react';
import type { Cue } from '../types';
import { formatTimestamp } from '../lib/time';
import { analyzeWrap, previewWrap } from '../lib/wrap';

interface WrapModalProps {
  cue: Cue;
  onClose: () => void;
  onApply: (id: string, maxCols: number) => void;
}

export default function WrapModal({ cue, onClose, onApply }: WrapModalProps) {
  const [colsStr, setColsStr] = useState('');

  // 标签校验 + 全文总列数（与列数输入无关，文本变化时重算）；已有换行的字幕不自动改写
  const analysis = useMemo(() => analyzeWrap(cue), [cue]);

  // 解析列数输入：留空不报错（只不显示预览）；非正整数立即报错
  const parsedCols = useMemo((): { n: number | null; error: string | null } => {
    const s = colsStr.trim();
    if (s === '') return { n: null, error: null };
    if (!/^[+-]?\d+$/.test(s)) return { n: null, error: '每行最大列数须为正整数' };
    const n = parseInt(s, 10);
    if (n < 1) return { n: null, error: '每行最大列数须为正整数' };
    return { n, error: null };
  }, [colsStr]);

  // 文本合法且列数为正整数时给出完整预览（含断点选择与上限检查）
  const result = useMemo(() => {
    if (!analysis.ok || parsedCols.n === null) return null;
    return previewWrap(cue, parsedCols.n);
  }, [analysis, parsedCols, cue]);

  const error = !analysis.ok
    ? analysis.error
    : parsedCols.error ?? (result && !result.ok ? result.error : null);
  const preview = result && result.ok ? result.preview : null;
  const canApply = preview !== null;

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="modal wide" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>自动换行</h2>
          <button className="btn icon" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="modal-hint">
          按 Unicode 显示宽度计列：宽字符/全角计 2 列；实体（如 <code>&amp;amp;</code>、
          <code>&amp;#x4E2D;</code>）作为一个可见字符、按所代表字符计列并原样保留；标签（如
          <code>&lt;b&gt;</code>）不计列且原样保留。只在原文空格或标点边界选断点
          （连续空白整段替换为换行；连续标点在其后断行），以「两行最长宽度最小、再宽度差最小」
          确定唯一断点，应用为最多两行；已有换行的字幕不自动改写。
        </p>

        <div className="split-source">
          <div className="split-source-head">
            <span className="col-label">原文</span>
            <span className="dim">
              {formatTimestamp(cue.start)} → {formatTimestamp(cue.end)}
              {analysis.ok ? ` · 共 ${analysis.totalWidth} 列` : ''}
            </span>
          </div>
          <div className="split-text">{cue.text}</div>
        </div>

        <div className="split-input-row">
          <label htmlFor="wrap-cols">每行最大列数</label>
          <input
            id="wrap-cols"
            value={colsStr}
            placeholder="如 16"
            spellCheck={false}
            inputMode="numeric"
            autoFocus
            disabled={!analysis.ok}
            onChange={(e) => setColsStr(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canApply && parsedCols.n !== null) {
                onApply(cue.id, parsedCols.n);
              }
            }}
          />
        </div>

        {error && <div className="modal-error">{error}</div>}

        {preview && (
          <>
            <div className="split-preview">
              <div className="split-seg">
                <div className="split-seg-head">
                  <span className="split-badge left">第一行</span>
                  <span className="dim">{preview.line1Width} 列</span>
                </div>
                <div className="split-text">{preview.line1}</div>
              </div>
              <div className="split-seg">
                <div className="split-seg-head">
                  <span className="split-badge right">第二行</span>
                  <span className="dim">{preview.line2Width} 列</span>
                </div>
                <div className="split-text">{preview.line2}</div>
              </div>
            </div>
            <p className="modal-hint">
              断点：{preview.kind === 'space' ? '空格边界' : '标点边界'} · 满足上限的候选断点{' '}
              {preview.feasibleCount} 个 · 应用后恰好两行
            </p>
          </>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={!canApply}
            title={canApply ? '只改写该条正文（保留 id 与起止时间，可一次撤销）' : '请先输入合法列数'}
            onClick={() => canApply && parsedCols.n !== null && onApply(cue.id, parsedCols.n)}
          >
            应用换行
          </button>
        </div>
      </div>
    </div>
  );
}
