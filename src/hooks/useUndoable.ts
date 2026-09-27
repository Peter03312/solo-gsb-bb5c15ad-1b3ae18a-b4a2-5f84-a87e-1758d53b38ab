import { useCallback, useRef, useState } from 'react';

export interface History<T> {
  present: T;
  past: T[];
  future: T[];
}

const COALESCE_MS = 1200;

/**
 * 离散快照式历史栈：每次提交一次编辑都会产生一条可撤销记录。
 */
export function useUndoable<T>(initial: T) {
  const [state, setState] = useState<History<T>>({ present: initial, past: [], future: [] });
  const batchRef = useRef<symbol | null>(null);
  const lastCommit = useRef<{ key: string; at: number } | null>(null);

  const present = state.present;
  const canUndo = state.past.length > 0;
  const canRedo = state.future.length > 0;

  const reset = useCallback((value: T) => {
    batchRef.current = null;
    lastCommit.current = null;
    setState({ present: value, past: [], future: [] });
  }, []);

  /** 提交一个新快照；相同 coalesceKey 在短时间内的提交会合并到同一条历史 */
  const commit = useCallback((next: T | ((prev: T) => T), coalesceKey?: string) => {
    batchRef.current = null;
    setState((s) => {
      const value = typeof next === 'function' ? (next as (p: T) => T)(s.present) : next;
      if (value === s.present) return s;
      const now = Date.now();
      const canCoalesce =
        coalesceKey !== undefined &&
        lastCommit.current?.key === coalesceKey &&
        now - lastCommit.current.at < COALESCE_MS &&
        s.past.length > 0;
      lastCommit.current = { key: coalesceKey ?? '', at: now };
      if (canCoalesce) {
        return { ...s, present: value, future: [] };
      }
      return { present: value, past: [...s.past, s.present], future: [] };
    });
  }, []);

  /**
   * 开始一次连续操作（如拖拽）：同一批次内只保留批次开始时的一个撤销点。
   */
  const beginBatch = useCallback(() => {
    const token = Symbol('batch');
    batchRef.current = token;
    lastCommit.current = null;
    setState((s) => ({ present: s.present, past: [...s.past, s.present], future: [] }));
    return token;
  }, []);

  /** 批次内实时更新（不产生额外撤销记录） */
  const updateBatch = useCallback((token: symbol, next: T | ((prev: T) => T)) => {
    setState((s) => {
      if (batchRef.current !== token) return s;
      const value = typeof next === 'function' ? (next as (p: T) => T)(s.present) : next;
      return { ...s, present: value };
    });
  }, []);

  /** 结束批次；若结果与批次开始前相同则回滚该撤销点 */
  const endBatch = useCallback((token: symbol) => {
    setState((s) => {
      if (batchRef.current !== token) return s;
      batchRef.current = null;
      const baseline = s.past[s.past.length - 1];
      if (baseline !== undefined && shallowEqual(baseline, s.present)) {
        return { ...s, past: s.past.slice(0, -1) };
      }
      return s;
    });
  }, []);

  const undo = useCallback(() => {
    batchRef.current = null;
    setState((s) => {
      if (s.past.length === 0) return s;
      const previous = s.past[s.past.length - 1];
      return {
        present: previous,
        past: s.past.slice(0, -1),
        future: [s.present, ...s.future],
      };
    });
  }, []);

  const redo = useCallback(() => {
    batchRef.current = null;
    setState((s) => {
      if (s.future.length === 0) return s;
      const nextVal = s.future[0];
      return {
        present: nextVal,
        past: [...s.past, s.present],
        future: s.future.slice(1),
      };
    });
  }, []);

  return {
    present,
    canUndo,
    canRedo,
    reset,
    commit,
    beginBatch,
    updateBatch,
    endBatch,
    undo,
    redo,
  };
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as CueLike;
    const y = b[i] as CueLike;
    if (!x || !y || x.start !== y.start || x.end !== y.end || x.text !== y.text || x.id !== y.id) {
      return false;
    }
  }
  return true;
}

interface CueLike {
  id: string;
  start: number;
  end: number;
  text: string;
}
