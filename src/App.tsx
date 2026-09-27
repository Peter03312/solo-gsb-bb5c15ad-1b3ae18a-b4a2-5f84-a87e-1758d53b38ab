import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Timeline from './components/Timeline';
import CueTable from './components/CueTable';
import ImportModal from './components/ImportModal';
import RemapModal from './components/RemapModal';
import TermModal from './components/TermModal';
import SplitModal from './components/SplitModal';
import WrapModal from './components/WrapModal';
import VideoPlayer from './components/VideoPlayer';
import { useUndoable } from './hooks/useUndoable';
import { parseVtt, serializeVtt } from './lib/vtt';
import { applyEdit } from './lib/engine';
import { applyRemap, type Anchor } from './lib/remap';
import { applyTerms, type TermRule } from './lib/terms';
import { splitCue } from './lib/split';
import { wrapCue } from './lib/wrap';
import { MIN_DURATION, formatTimestamp } from './lib/time';
import type { Cue } from './types';

function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `cue-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export default function App() {
  const history = useUndoable<Cue[]>([]);
  const { present: cues, commit, reset, undo, redo, canUndo, canRedo, beginBatch, updateBatch, endBatch } = history;

  const [showImport, setShowImport] = useState(true);
  const [showRemap, setShowRemap] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [splitId, setSplitId] = useState<string | null>(null);
  const [wrapId, setWrapId] = useState<string | null>(null);
  const [termRules, setTermRules] = useState<TermRule[]>([
    { id: makeId(), source: '', target: '' },
  ]);
  const [chainMode, setChainMode] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoName, setVideoName] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const controlsRef = useRef<{ seek: (t: number) => void; togglePlay: () => void } | null>(null);

  const cuesDuration = useMemo(() => cues.reduce((m, c) => Math.max(m, c.end), 0), [cues]);
  const duration = videoDuration ?? Math.max(cuesDuration + 2, 10);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2200);
  }, []);

  // ---------- 导入 / 示例 ----------
  const handleImport = useCallback(
    (vtt: string): boolean => {
      const parsed = parseVtt(vtt);
      if (parsed.length === 0) return false;
      reset(parsed);
      setSelectedId(parsed[0]?.id ?? null);
      setPlayhead(0);
      flash(`已导入 ${parsed.length} 条字幕`);
      return true;
    },
    [reset, flash],
  );

  const loadSample = useCallback(async () => {
    try {
      const res = await fetch('./sample.vtt');
      const text = await res.text();
      handleImport(text);
      setShowImport(false);
    } catch {
      flash('示例加载失败');
    }
  }, [handleImport, flash]);

  // ---------- 时间轴拖拽（实时预览 + 单个撤销点） ----------
  const batchTokenRef = useRef<symbol | null>(null);
  const dragStart = useCallback(() => {
    const t = beginBatch();
    batchTokenRef.current = t;
    return t;
  }, [beginBatch]);
  const liveEdit = useCallback(
    (next: Cue[]) => {
      if (batchTokenRef.current) updateBatch(batchTokenRef.current, next);
    },
    [updateBatch],
  );
  const dragEnd = useCallback(
    (token: symbol) => {
      endBatch(token);
      batchTokenRef.current = null;
    },
    [endBatch],
  );

  // ---------- 列表编辑 ----------
  const editTimes = useCallback(
    (id: string, start: number, end: number) => {
      commit((prev) => {
        const merged = prev
          .map((c) => (c.id === id ? { ...c, start, end } : { ...c }))
          .sort((a, b) => a.start - b.start || a.end - b.end);
        // 对目标条做两次编辑（end 与 start 取当前值），引擎按当前模式处理重叠
        const idx1 = merged.findIndex((c) => c.id === id);
        const afterEnd = applyEdit(merged, 'end', idx1, merged[idx1].end, chainMode);
        const idx2 = afterEnd.findIndex((c) => c.id === id);
        return applyEdit(afterEnd, 'start', idx2, afterEnd[idx2].start, chainMode);
      }, `times-${id}`);
    },
    [commit, chainMode],
  );

  const editText = useCallback(
    (id: string, text: string) => {
      commit((prev) => prev.map((c) => (c.id === id ? { ...c, text } : c)), `text-${id}`);
    },
    [commit],
  );

  const deleteCue = useCallback(
    (id: string) => {
      commit((prev) => prev.filter((c) => c.id !== id));
      setSelectedId((sel) => (sel === id ? null : sel));
      setSplitId((sid) => (sid === id ? null : sid));
      setWrapId((wid) => (wid === id ? null : wid));
    },
    [commit],
  );

  const insertCue = useCallback(
    (afterId: string | null) => {
      let newId = '';
      commit((prev) => {
        const sorted = [...prev].sort((a, b) => a.start - b.start);
        if (sorted.length === 0) {
          const only: Cue[] = [{ id: makeId(), start: 0, end: MIN_DURATION, text: '新字幕' }];
          newId = only[0].id;
          return only;
        }
        const idx = afterId
          ? sorted.findIndex((c) => c.id === afterId)
          : sorted.length - 1;
        const anchor = sorted[Math.max(0, idx)];
        // 追加到指定锚点（默认最后一条）之后；空间不足时由连锁引擎推开
        const start = anchor.end + 0.05;
        const cue: Cue = { id: makeId(), start, end: start + MIN_DURATION, text: '新字幕' };
        newId = cue.id;
        const merged = [...sorted, cue].sort((a, b) => a.start - b.start);
        const newIdx = merged.findIndex((c) => c.id === cue.id);
        return applyEdit(merged, 'move', newIdx, merged[newIdx].start, true);
      });
      if (newId) setSelectedId(newId);
    },
    [commit],
  );

  // ---------- 拆分 ----------
  const openSplit = useCallback((id: string) => {
    setSelectedId(id);
    setSplitId(id);
  }, []);

  const applySplit = useCallback(
    (id: string, n: number) => {
      // 先基于当前状态算好两段（含新 id），再一次提交 ⇒ 整次拆分只占一条撤销记录
      const cue = cues.find((c) => c.id === id);
      if (!cue) return;
      const parts = splitCue(cue, n, makeId);
      if (!parts) return;
      commit((prev) => {
        const idx = prev.findIndex((c) => c.id === id);
        if (idx < 0) return prev;
        return [...prev.slice(0, idx), parts[0], parts[1], ...prev.slice(idx + 1)];
      });
      setSplitId(null);
      setSelectedId(parts[0].id);
      flash('已拆分为两条字幕');
    },
    [cues, commit, flash],
  );

  // ---------- 自动换行 ----------
  const openWrap = useCallback((id: string) => {
    setSelectedId(id);
    setWrapId(id);
  }, []);

  const applyWrap = useCallback(
    (id: string, maxCols: number) => {
      // 先基于当前状态算好新正文，再一次提交 ⇒ 整次换行只占一条撤销记录
      const cue = cues.find((c) => c.id === id);
      if (!cue) return;
      const r = wrapCue(cue, maxCols);
      if (!r) return;
      commit((prev) => prev.map((c) => (c.id === id ? { ...c, text: r.newText } : c)));
      setWrapId(null);
      flash('已应用自动换行（仅该条正文，id 与时间不变）');
    },
    [cues, commit, flash],
  );

  // ---------- 视频 ----------
  const onLoadVideo = useCallback((file: File) => {
    setVideoUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(file);
    });
    setVideoName(file.name);
  }, []);

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  // ---------- 快捷键 ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = e.target instanceof HTMLElement ? e.target.tagName : '';
      const typing = tag === 'INPUT' || tag === 'TEXTAREA';
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if (!typing && e.key === ' ') {
        e.preventDefault();
        controlsRef.current?.togglePlay();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  // ---------- 剪辑版本时间映射 ----------
  const applyVersionRemap = useCallback(
    (anchors: Anchor[]) => {
      // 一次性替换全部字幕时间（保留 id/文本），只产生一条撤销记录
      commit((prev) => applyRemap(prev, anchors));
      setShowRemap(false);
      flash('已应用剪辑版本时间映射');
    },
    [commit, flash],
  );

  // ---------- 术语审校 ----------
  const applyTerminology = useCallback(
    (rules: TermRule[], selectedIds: Set<string>) => {
      // 仅替换所勾选字幕的文本（时间与 id 不变），一次提交只产生一条撤销记录
      commit((prev) => applyTerms(prev, rules, selectedIds));
      setShowTerms(false);
      flash(`已在 ${selectedIds.size} 条字幕中应用术语替换`);
    },
    [commit, flash],
  );

  // ---------- 导出 ----------
  const exportVtt = useCallback(() => {
    const content = serializeVtt(cues);
    const blob = new Blob([content], { type: 'text/vtt;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'fixed-subtitles.vtt';
    a.click();
    URL.revokeObjectURL(url);
    flash('已导出 fixed-subtitles.vtt');
  }, [cues, flash]);

  const copyVtt = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(serializeVtt(cues));
      flash('VTT 已复制到剪贴板');
    } catch {
      flash('复制失败，请使用导出下载');
    }
  }, [cues, flash]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">⏱</span>
          <h1>WebVTT 字幕校时台</h1>
        </div>
        <div className="toolbar">
          <button className="btn" onClick={() => setShowImport(true)}>
            导入 VTT
          </button>
          <button className="btn" onClick={loadSample}>
            载入示例
          </button>
          <span className="divider" />
          <button className="btn icon" onClick={undo} disabled={!canUndo} title="撤销 (Ctrl+Z)">
            ↶
          </button>
          <button className="btn icon" onClick={redo} disabled={!canRedo} title="重做 (Ctrl+Shift+Z)">
            ↷
          </button>
          <span className="divider" />
          <label className={`toggle${chainMode ? ' on' : ''}`}>
            <input
              type="checkbox"
              checked={chainMode}
              onChange={(e) => setChainMode(e.target.checked)}
            />
            <span>连锁模式</span>
          </label>
          <span className="divider" />
          <button className="btn" onClick={() => setShowRemap(true)} disabled={cues.length === 0}>
            版本映射
          </button>
          <button className="btn" onClick={() => setShowTerms(true)} disabled={cues.length === 0}>
            术语审校
          </button>
          <span className="divider" />
          <button className="btn" onClick={copyVtt} disabled={cues.length === 0}>
            复制
          </button>
          <button className="btn primary" onClick={exportVtt} disabled={cues.length === 0}>
            导出 VTT
          </button>
        </div>
      </header>

      <main className="main">
        <section className="center-pane">
          <VideoPlayer
            videoUrl={videoUrl}
            videoName={videoName}
            onTimeUpdate={setPlayhead}
            onDurationChange={setVideoDuration}
            onPlayStateChange={setPlaying}
            onLoadFile={onLoadVideo}
            registerControls={(c) => {
              controlsRef.current = c;
            }}
          />
          <Timeline
            cues={cues}
            duration={duration}
            playhead={playhead}
            playing={playing}
            chainMode={chainMode}
            selectedId={selectedId}
            onLiveEdit={liveEdit}
            onDragStart={dragStart}
            onDragEnd={dragEnd}
            onSeek={(t) => {
              setPlayhead(t);
              controlsRef.current?.seek(t);
            }}
            onSelect={setSelectedId}
          />
          <div className="hint-bar">
            <span>💡 拖动块体平移 · 拖左右边缘改起止 · 100ms 内自动吸附播放头/相邻边界</span>
            <span className="playhead-time">播放头 {formatTimestamp(playhead)}</span>
          </div>
        </section>

        <aside className="side-pane">
          <CueTable
            cues={cues}
            selectedId={selectedId}
            playhead={playhead}
            onSelect={(id) => {
              setSelectedId(id);
              const c = cues.find((x) => x.id === id);
              if (c) {
                setPlayhead(c.start);
                controlsRef.current?.seek(c.start);
              }
            }}
            onEditTimes={editTimes}
            onEditText={editText}
            onDelete={deleteCue}
            onInsert={insertCue}
            onSplit={openSplit}
            onWrap={openWrap}
          />
        </aside>
      </main>

      {showImport && (
        <ImportModal
          onClose={() => setShowImport(false)}
          onImport={handleImport}
        />
      )}
      {showRemap && (
        <RemapModal
          cues={cues}
          onClose={() => setShowRemap(false)}
          onApply={applyVersionRemap}
        />
      )}
      {showTerms && (
        <TermModal
          cues={cues}
          rules={termRules}
          onRulesChange={setTermRules}
          onClose={() => setShowTerms(false)}
          onApply={applyTerminology}
        />
      )}
      {splitId !== null &&
        (() => {
          const cue = cues.find((c) => c.id === splitId);
          return cue ? (
            <SplitModal cue={cue} onClose={() => setSplitId(null)} onApply={applySplit} />
          ) : null;
        })()}
      {wrapId !== null &&
        (() => {
          const cue = cues.find((c) => c.id === wrapId);
          return cue ? (
            <WrapModal cue={cue} onClose={() => setWrapId(null)} onApply={applyWrap} />
          ) : null;
        })()}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
