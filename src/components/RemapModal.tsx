import { Fragment, useMemo, useState } from 'react';
import type { Cue } from '../types';
import { formatTimestamp, parseTimestamp } from '../lib/time';
import {
  previewRemap,
  validateAnchors,
  type Anchor,
  type RemapIssueKind,
} from '../lib/remap';

interface RemapModalProps {
  cues: Cue[];
  onClose: () => void;
  onApply: (anchors: Anchor[]) => void;
}

interface AnchorRow {
  key: number;
  oldStr: string;
  newStr: string;
}

let rowKey = 0;
const nextKey = () => ++rowKey;

const ISSUE_LABEL: Record<RemapIssueKind, string> = {
  'negative-start': '负起点',
  'short-duration': '时长<300ms',
  overlap: '相邻重叠',
};

/** 预览中需要显示可能为负的时间，formatTimestamp 会夹到 0，这里补负号 */
function formatSigned(seconds: number): string {
  return seconds < 0 ? `-${formatTimestamp(-seconds)}` : formatTimestamp(seconds);
}

export default function RemapModal({ cues, onClose, onApply }: RemapModalProps) {
  const [rows, setRows] = useState<AnchorRow[]>([
    { key: nextKey(), oldStr: '', newStr: '' },
    { key: nextKey(), oldStr: '', newStr: '' },
  ]);

  // 解析 + 校验锚点（完全留空的行忽略；只填一半或格式错误则报错）
  const parsed = useMemo(() => {
    const anchors: Anchor[] = [];
    for (const r of rows) {
      const oldEmpty = r.oldStr.trim() === '';
      const newEmpty = r.newStr.trim() === '';
      if (oldEmpty && newEmpty) continue;
      const o = parseTimestamp(r.oldStr);
      const n = parseTimestamp(r.newStr);
      if (o === null || n === null) {
        return {
          anchors: [] as Anchor[],
          error: '存在无法解析的时间，格式应为 HH:MM:SS.mmm 或 MM:SS.mmm',
        };
      }
      anchors.push({ oldTime: o, newTime: n });
    }
    return { anchors, error: validateAnchors(anchors) };
  }, [rows]);

  // 锚点任何变动都会触发预览重算
  const preview = useMemo(
    () => (parsed.error === null ? previewRemap(cues, parsed.anchors) : null),
    [cues, parsed],
  );

  const updateRow = (key: number, field: 'oldStr' | 'newStr', value: string) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
  };
  const removeRow = (key: number) => setRows((rs) => rs.filter((r) => r.key !== key));
  const addRow = () => setRows((rs) => [...rs, { key: nextKey(), oldStr: '', newStr: '' }]);

  const hasAnyInput = rows.some((r) => r.oldStr.trim() !== '' || r.newStr.trim() !== '');
  const canApply = preview !== null && preview.ok && preview.rows.length > 0;

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="modal wide" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>剪辑版本时间映射</h2>
          <button className="btn icon" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="modal-hint">
          输入至少 2 组「旧版时间 → 新版时间」锚点，两侧时间都须严格递增。
          相邻锚点之间按分段线性映射，区间之外按最近一段的斜率外推；每条字幕的起止点都会按此重算。
        </p>

        <div className="anchor-grid">
          <span className="col-label">旧版时间</span>
          <span />
          <span className="col-label">新版时间</span>
          <span />
          {rows.map((r) => (
            <Fragment key={r.key}>
              <input
                value={r.oldStr}
                placeholder="00:00:10.000"
                spellCheck={false}
                onChange={(e) => updateRow(r.key, 'oldStr', e.target.value)}
              />
              <span className="arrow">→</span>
              <input
                value={r.newStr}
                placeholder="00:00:12.500"
                spellCheck={false}
                onChange={(e) => updateRow(r.key, 'newStr', e.target.value)}
              />
              <button
                className="btn tiny danger"
                title="删除该锚点"
                disabled={rows.length <= 1}
                onClick={() => removeRow(r.key)}
              >
                ✕
              </button>
            </Fragment>
          ))}
        </div>
        <div className="anchor-add">
          <button className="btn small" onClick={addRow}>
            + 添加锚点
          </button>
        </div>

        {parsed.error && hasAnyInput && <div className="modal-error">{parsed.error}</div>}

        {preview && (
          <>
            <div className={`remap-summary ${preview.ok ? 'ok' : 'bad'}`}>
              {preview.ok
                ? `预览：${preview.rows.length} 条字幕将全部重排，未发现问题，可以应用。`
                : `发现 ${preview.issues.length} 处问题（已标红），修正锚点前无法应用。`}
            </div>
            <div className="remap-preview">
              <table className="remap-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>旧起点 → 新起点</th>
                    <th>旧终点 → 新终点</th>
                    <th>问题</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row, i) => (
                    <tr key={row.cue.id} className={row.issues.length > 0 ? 'issue' : ''}>
                      <td>{i + 1}</td>
                      <td>
                        {formatTimestamp(row.cue.start)} → {formatSigned(row.newStart)}
                      </td>
                      <td>
                        {formatTimestamp(row.cue.end)} → {formatSigned(row.newEnd)}
                      </td>
                      <td>
                        {row.issues.map((k) => (
                          <span key={k} className="issue-tag">
                            {ISSUE_LABEL[k]}
                          </span>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={!canApply}
            title={canApply ? '一次性替换全部字幕时间（可撤销）' : '预览存在问题时禁止应用'}
            onClick={() => onApply(parsed.anchors)}
          >
            应用映射
          </button>
        </div>
      </div>
    </div>
  );
}
