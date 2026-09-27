export interface Cue {
  id: string;
  start: number; // seconds
  end: number; // seconds
  text: string;
  note?: string;
}

export type EditKind = 'move' | 'start' | 'end';

export interface EditRequest {
  kind: EditKind;
  index: number;
  value: number; // move: 新起点；start: 新起点；end: 新终点
  chain: boolean;
}

export interface SnapResult {
  start: number;
  end: number;
  snapTime: number | null;
}
