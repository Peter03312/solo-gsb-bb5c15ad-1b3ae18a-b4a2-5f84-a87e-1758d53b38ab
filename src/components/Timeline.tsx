import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Cue, EditKind } from '../types';
import { applyEdit, computeSnap } from '../lib/engine';

interface TimelineProps {
  cues: Cue[];
  duration: number;
  playhead: number;
  playing: boolean;
  chainMode: boolean;
  selectedId: string | null;
  onLiveEdit: (cues: Cue[]) => void;
  onDragStart: () => symbol;
  onDragEnd: (token: symbol) => void;
  onSeek: (t: number) => void;
  onSelect: (id: string) => void;
}

interface DragState {
  token: symbol;
  kind: EditKind;
  index: number;
  pointerId: number;
  startX: number;
  origStart: number;
  origEnd: number;
}

const PX_PER_SEC_LEVELS = [10, 20, 40, 80, 160, 320];
const RULER_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 300, 600];

export default function Timeline(props: TimelineProps) {
  const {
    cues,
    duration,
    playhead,
    chainMode,
    selectedId,
    onSeek,
    onSelect,
  } = props;

  const scrollRef = useRef<HTMLDivElement>(null);
  const [zoomLevel, setZoomLevel] = useState(2);
  const pxPerSec = PX_PER_SEC_LEVELS[zoomLevel];
  const timelineWidth = Math.max((duration + 1) * pxPerSec, 600);

  const [snapLine, setSnapLine] = useState<number | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  const ticks = useMemo(() => buildTicks(duration, pxPerSec), [duration, pxPerSec]);

  const timeAtClientX = useCallback(
    (clientX: number) => {
      const el = scrollRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      const x = clientX - rect.left + el.scrollLeft;
      return Math.max(0, x / pxPerSec);
    },
    [pxPerSec],
  );

  const autoScroll = useCallback((clientX: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const edge = 48;
    if (clientX > rect.right - edge) el.scrollLeft += 16;
    else if (clientX < rect.left + edge) el.scrollLeft -= 16;
  }, []);

  const beginDrag = useCallback(
    (e: React.PointerEvent, kind: EditKind, index: number) => {
      e.stopPropagation();
      const cue = propsRef.current.cues[index];
      const token = propsRef.current.onDragStart();
      dragRef.current = {
        token,
        kind,
        index,
        pointerId: e.pointerId,
        startX: e.clientX,
        origStart: cue.start,
        origEnd: cue.end,
      };
      onSelect(cue.id);
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    },
    [onSelect],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const p = propsRef.current;
      const deltaT = (e.clientX - drag.startX) / pxPerSec;

      let nextCues: Cue[];
      if (drag.kind === 'move') {
        const snapped = computeSnap(
          p.cues,
          drag.index,
          'move',
          drag.origStart + deltaT,
          drag.origEnd + deltaT,
          p.playhead,
        );
        setSnapLine(snapped.snapTime);
        nextCues = applyEdit(p.cues, 'move', drag.index, snapped.start, p.chainMode);
      } else if (drag.kind === 'start') {
        const snapped = computeSnap(
          p.cues,
          drag.index,
          'start',
          drag.origStart + deltaT,
          drag.origEnd,
          p.playhead,
        );
        setSnapLine(snapped.snapTime);
        nextCues = applyEdit(p.cues, 'start', drag.index, snapped.start, p.chainMode);
      } else {
        const snapped = computeSnap(
          p.cues,
          drag.index,
          'end',
          drag.origStart,
          drag.origEnd + deltaT,
          p.playhead,
        );
        setSnapLine(snapped.snapTime);
        nextCues = applyEdit(p.cues, 'end', drag.index, snapped.end, p.chainMode);
      }

      p.onLiveEdit(nextCues);
      autoScroll(e.clientX);
    },
    [pxPerSec, autoScroll],
  );

  const endDrag = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      setSnapLine(null);
      propsRef.current.onDragEnd(drag.token);
      try {
        (e.currentTarget as Element).releasePointerCapture(drag.pointerId);
      } catch {
        /* pointer 已释放 */
      }
    },
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const el = scrollRef.current;
      if (!el || dragRef.current) return;
      if (e.key === 'ArrowRight') el.scrollLeft += 80;
      if (e.key === 'ArrowLeft') el.scrollLeft -= 80;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 播放时自动跟随
  useEffect(() => {
    if (!props.playing) return;
    const el = scrollRef.current;
    if (!el) return;
    const x = playhead * pxPerSec;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 80) {
      el.scrollLeft = x - el.clientWidth / 2;
    }
  }, [playhead, pxPerSec, props.playing]);

  const headX = Math.min(playhead, duration + 1) * pxPerSec;

  return (
    <div className="timeline-wrap">
      <div className="timeline-toolbar">
        <button
          className="btn icon"
          onClick={() => setZoomLevel((z) => Math.max(0, z - 1))}
          disabled={zoomLevel === 0}
          title="缩小"
        >
          −
        </button>
        <span className="zoom-label">{pxPerSec}px/秒</span>
        <button
          className="btn icon"
          onClick={() => setZoomLevel((z) => Math.min(PX_PER_SEC_LEVELS.length - 1, z + 1))}
          disabled={zoomLevel === PX_PER_SEC_LEVELS.length - 1}
          title="放大"
        >
          +
        </button>
        <button
          className="btn"
          onClick={() => {
            const el = scrollRef.current;
            if (el) el.scrollLeft = headX - el.clientWidth / 2;
          }}
        >
          定位播放头
        </button>
        <span className={chainMode ? 'chain-badge on' : 'chain-badge'}>
          {chainMode ? '连锁模式：开' : '连锁模式：关'}
        </span>
      </div>

      <div
        className="timeline-scroll"
        ref={scrollRef}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="timeline-inner" style={{ width: timelineWidth }}>
          <div
            className="ruler"
            onPointerDown={(e) => onSeek(timeAtClientX(e.clientX))}
          >
            {ticks.map((tk) => (
              <div key={tk.time} className="tick" style={{ left: tk.time * pxPerSec }}>
                <span className="tick-label">{tk.label}</span>
              </div>
            ))}
          </div>

          <div className="track">
            {cues.map((cue, i) => {
              const left = cue.start * pxPerSec;
              const width = Math.max((cue.end - cue.start) * pxPerSec, 6);
              const selected = cue.id === selectedId;
              return (
                <div
                  key={cue.id}
                  className={`cue-block${selected ? ' selected' : ''}`}
                  style={{ left, width }}
                  onPointerDown={(e) => beginDrag(e, 'move', i)}
                  title={`${cue.start.toFixed(2)}s → ${cue.end.toFixed(2)}s\n${cue.text.split('\n')[0]}`}
                >
                  <div
                    className="cue-handle left"
                    onPointerDown={(e) => beginDrag(e, 'start', i)}
                  />
                  <div className="cue-label">{cue.text.split('\n')[0] || '(空字幕)'}</div>
                  <div
                    className="cue-handle right"
                    onPointerDown={(e) => beginDrag(e, 'end', i)}
                  />
                </div>
              );
            })}
          </div>

          {snapLine !== null && (
            <div className="snap-line" style={{ left: snapLine * pxPerSec }} />
          )}

          <div className="playhead" style={{ left: headX }}>
            <div className="playhead-cap" />
            <div className="playhead-line" />
          </div>
        </div>
      </div>
    </div>
  );
}

function buildTicks(duration: number, pxPerSec: number): Array<{ time: number; label: string }> {
  const minPx = 70;
  const step = RULER_STEPS.find((s) => s * pxPerSec >= minPx) ?? 600;
  const ticks: Array<{ time: number; label: string }> = [];
  for (let t = 0; t <= duration + 0.001; t += step) {
    ticks.push({ time: t, label: step < 1 ? t.toFixed(1) + 's' : formatShort(t) });
  }
  return ticks;
}

function formatShort(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
