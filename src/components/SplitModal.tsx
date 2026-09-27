import { useMemo, useState } from 'react';
import type { Cue } from '../types';
import { formatTimestamp } from '../lib/time';
import { analyzeCueText, previewSplit } from '../lib/split';

interface SplitModalProps {
  cue: Cue;
  onClose: () => void;
  onApply: (id: string, n: number) => void;
}

export default function SplitModal({ cue, onClose, onApply }: SplitModalProps) {
  const [nStr, setNStr] = useState('');

  // 标签校验 + 可见总字数（与切点输入无关，文本变化时重算）
  const analysis = useMemo(() => analyzeCueText(cue.text), [cue.text]);

  // 解析切点输入：留空不报错（只不显示预览）；非整数立即报错
  const parsedN = useMemo((): { n: number | null; error: string | null } => {
    const s = nStr.trim();
    if (s === '') return { n: null, error: null };
    if (!/^[+-]?\d+$/.test(s)) return { n: null, error: '切点 N 必须是整数' };
    return { n: parseInt(s, 10), error: null };
  }, [nStr]);

  // 文本合法且切点为整数时给出完整预览（含时间计算与 300ms 检查）
  const result = useMemo(() => {
    if (!analysis.ok || parsedN.n === null) return null;
    return previewSplit(cue, parsedN.n);
  }, [analysis, parsedN, cue]);

  const error = !analysis.ok
    ? analysis.error
    : parsedN.error ?? (result && !result.ok ? result.error : null);
  const preview = result && result.ok ? result.preview : null;
  const canApply = preview !== null;

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="modal wide" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>拆分字幕</h2>
          <button className="btn icon" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="modal-hint">
          按可见字数拆分：每个 Unicode 码点计 1 字（换行计 1 字）；实体（如
          <code>&amp;amp;</code>、<code>&amp;#65;</code>）各计 1 字并原样保留；标签（如
          <code>&lt;b&gt;</code>）不计。切点处未闭合的标签会在左段闭合、在右段原样重开。
          分割时间 = 原起点 + 原时长 × N / 总字数（四舍五入到毫秒），两段均不得短于 300ms。
        </p>

        <div className="split-source">
          <div className="split-source-head">
            <span className="col-label">原文</span>
            <span className="dim">
              {formatTimestamp(cue.start)} → {formatTimestamp(cue.end)}
              {analysis.ok ? ` · 可见 ${analysis.total} 字` : ''}
            </span>
          </div>
          <div className="split-text">{cue.text}</div>
        </div>

        <div className="split-input-row">
          <label htmlFor="split-n">切点 N（第 N 字之后断开）</label>
          <input
            id="split-n"
            value={nStr}
            placeholder={analysis.ok && analysis.total >= 2 ? `1 ~ ${analysis.total - 1}` : '—'}
            spellCheck={false}
            inputMode="numeric"
            autoFocus
            disabled={!analysis.ok || analysis.total < 2}
            onChange={(e) => setNStr(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canApply && parsedN.n !== null) {
                onApply(cue.id, parsedN.n);
              }
            }}
          />
        </div>

        {error && <div className="modal-error">{error}</div>}

        {preview && (
          <div className="split-preview">
            <div className="split-seg">
              <div className="split-seg-head">
                <span className="split-badge left">左段</span>
                <span className="dim">
                  {formatTimestamp(preview.leftStart)} → {formatTimestamp(preview.leftEnd)} ·{' '}
                  {preview.leftCount} 字
                </span>
              </div>
              <div className="split-text">{preview.leftText}</div>
            </div>
            <div className="split-seg">
              <div className="split-seg-head">
                <span className="split-badge right">右段</span>
                <span className="dim">
                  {formatTimestamp(preview.rightStart)} → {formatTimestamp(preview.rightEnd)} ·{' '}
                  {preview.rightCount} 字
                </span>
              </div>
              <div className="split-text">{preview.rightText}</div>
            </div>
          </div>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={!canApply}
            title={canApply ? '用两条新字幕替换原条（可一次撤销）' : '请先输入合法切点'}
            onClick={() => canApply && parsedN.n !== null && onApply(cue.id, parsedN.n)}
          >
            应用拆分
          </button>
        </div>
      </div>
    </div>
  );
}
