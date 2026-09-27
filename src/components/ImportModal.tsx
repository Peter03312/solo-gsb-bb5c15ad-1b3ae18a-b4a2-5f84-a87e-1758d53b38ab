import { useState } from 'react';

interface ImportModalProps {
  onClose: () => void;
  onImport: (vtt: string) => boolean;
}

export default function ImportModal({ onClose, onImport }: ImportModalProps) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result ?? '');
      if (!doImport(content)) setText(content);
    };
    reader.readAsText(file);
  };

  const doImport = (content: string): boolean => {
    const ok = onImport(content);
    if (ok) {
      onClose();
      return true;
    }
    setError('未解析到任何合法字幕，请检查内容是否为 WebVTT 格式');
    return false;
  };

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="modal" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>导入 WebVTT</h2>
          <button className="btn icon" onClick={onClose}>
            ✕
          </button>
        </div>
        <label
          className={`drop-zone${dragging ? ' dragging' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files?.[0];
            if (f) handleFile(f);
          }}
        >
          <input
            type="file"
            accept=".vtt,text/vtt"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
            }}
          />
          <span>点击选择 .vtt 文件，或直接拖拽文件到此处</span>
        </label>
        <p className="modal-hint">也可以直接把 VTT 文本粘贴到下面：</p>
        <textarea
          className="vtt-input"
          value={text}
          spellCheck={false}
          placeholder={'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n字幕文本'}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
        />
        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={text.trim() === ''} onClick={() => doImport(text)}>
            导入
          </button>
        </div>
      </div>
    </div>
  );
}
