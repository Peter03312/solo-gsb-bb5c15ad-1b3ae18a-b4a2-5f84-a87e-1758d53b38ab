import { Fragment, useMemo, useState } from 'react';
import type { Cue } from '../types';
import { formatTimestamp } from '../lib/time';
import {
  effectiveRules,
  previewTerms,
  validateRules,
  type TermRule,
} from '../lib/terms';

interface TermModalProps {
  cues: Cue[];
  rules: TermRule[];
  onRulesChange: (rules: TermRule[]) => void;
  onClose: () => void;
  onApply: (rules: TermRule[], selectedIds: Set<string>) => void;
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `rule-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** 把 text 中 ranges 区间渲染为高亮片段（区间有序且互不重叠） */
function renderMarked(text: string, ranges: Array<{ start: number; end: number }>, cls: string) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  ranges.forEach((r, i) => {
    if (r.start > last) parts.push(text.slice(last, r.start));
    parts.push(
      <mark key={i} className={cls}>
        {text.slice(r.start, r.end)}
      </mark>,
    );
    last = r.end;
  });
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export default function TermModal({ cues, rules, onRulesChange, onClose, onApply }: TermModalProps) {
  // 记录被取消勾选的 cue id；新出现的命中默认勾选
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());

  const error = useMemo(() => validateRules(rules), [rules]);
  const hasAnyInput = rules.some((r) => r.source.trim() !== '' || r.target.trim() !== '');

  // 规则或字幕任何变动都会触发预览重算；存在非法规则时不出预览
  const preview = useMemo(
    () => (error === null ? previewTerms(cues, rules) : null),
    [cues, rules, error],
  );

  const rows = preview ?? [];
  const totalHits = rows.reduce((n, r) => n + r.hits.length, 0);
  const selectedIds = rows.filter((r) => !unchecked.has(r.cue.id)).map((r) => r.cue.id);
  const allChecked = rows.length > 0 && selectedIds.length === rows.length;
  const canApply = preview !== null && selectedIds.length > 0;

  const updateRule = (id: string, field: 'source' | 'target', value: string) => {
    onRulesChange(rules.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  };
  const removeRule = (id: string) => onRulesChange(rules.filter((r) => r.id !== id));
  const addRule = () => onRulesChange([...rules, { id: makeId(), source: '', target: '' }]);

  const toggleOne = (id: string) => {
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setUnchecked(allChecked ? new Set(rows.map((r) => r.cue.id)) : new Set());
  };

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="modal xwide" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>术语审校</h2>
          <button className="btn icon" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="modal-hint">
          按字幕正文中的可见文本做区分大小写的字面匹配；WebVTT 内联标签（如
          <code>&lt;b&gt;</code>）与实体（如 <code>&amp;amp;</code>）作为边界原样保留、不参与匹配。
          同一位置多条规则命中时取最长原词，等长按规则顺序；已匹配的字符不再重复匹配。
        </p>

        <div className="term-grid">
          <span className="col-label">原词</span>
          <span />
          <span className="col-label">推荐词</span>
          <span />
          {rules.map((r) => (
            <Fragment key={r.id}>
              <input
                value={r.source}
                placeholder="如：帐号"
                spellCheck={false}
                onChange={(e) => updateRule(r.id, 'source', e.target.value)}
              />
              <span className="arrow">→</span>
              <input
                value={r.target}
                placeholder="如：账号"
                spellCheck={false}
                onChange={(e) => updateRule(r.id, 'target', e.target.value)}
              />
              <button
                className="btn tiny danger"
                title="删除该规则"
                disabled={rules.length <= 1}
                onClick={() => removeRule(r.id)}
              >
                ✕
              </button>
            </Fragment>
          ))}
        </div>
        <div className="term-add">
          <button className="btn small" onClick={addRule}>
            + 添加规则
          </button>
        </div>

        {error && hasAnyInput && <div className="modal-error">{error}</div>}

        {preview !== null && (
          <>
            <div className={`term-summary ${rows.length > 0 ? 'ok' : ''}`}>
              {rows.length === 0
                ? effectiveRules(rules).length === 0
                  ? '请先填写至少一条完整规则（原词与推荐词均非空、原词不重复）。'
                  : '当前规则没有命中任何字幕。'
                : `预览：${rows.length} 条字幕共 ${totalHits} 处命中，已勾选 ${selectedIds.length} 条。`}
            </div>
            {rows.length > 0 && (
              <div className="term-preview">
                <table className="term-table">
                  <thead>
                    <tr>
                      <th className="check-col">
                        <input
                          type="checkbox"
                          checked={allChecked}
                          onChange={toggleAll}
                          title="全选 / 全不选"
                          aria-label="全选"
                        />
                      </th>
                      <th># / 时间</th>
                      <th>命中（原词→推荐词 @位置）</th>
                      <th>原文</th>
                      <th>替换后正文</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => {
                      const checked = !unchecked.has(row.cue.id);
                      return (
                        <tr key={row.cue.id} className={checked ? '' : 'off'}>
                          <td className="check-col">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleOne(row.cue.id)}
                              aria-label={`勾选第 ${i + 1} 条`}
                            />
                          </td>
                          <td className="nowrap">
                            {i + 1}
                            <br />
                            <span className="dim">
                              {formatTimestamp(row.cue.start)} → {formatTimestamp(row.cue.end)}
                            </span>
                          </td>
                          <td>
                            {row.hits.map((h, j) => (
                              <span key={j} className="term-hit" title={`原文下标 ${h.start}–${h.end}`}>
                                {h.source}→{h.target} @{h.start}
                              </span>
                            ))}
                          </td>
                          <td className="term-text">
                            {renderMarked(
                              row.cue.text,
                              row.hits.map((h) => ({ start: h.start, end: h.end })),
                              'mark-old',
                            )}
                          </td>
                          <td className="term-text">{renderMarked(row.newText, row.newRanges, 'mark-new')}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={!canApply}
            title={canApply ? '仅替换所勾选字幕的文本（一次撤销记录，时间与 id 不变）' : '没有可应用的勾选字幕'}
            onClick={() => onApply(effectiveRules(rules), new Set(selectedIds))}
          >
            应用替换（{selectedIds.length}）
          </button>
        </div>
      </div>
    </div>
  );
}
